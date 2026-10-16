import type { Folder, FolderRequest, FolderUse, FolderUserAccess, FoldersResponse } from '@apexos/api-types';
import type { TrueNasClient } from '@apexos/truenas-client';
import type { AppContext } from '../app.ts';
import { UserError } from '../lib/errors.ts';
import { foldernameFormat } from '../lib/validators.ts';
import { GiB, propNumber, userProp } from '../truenas/helpers.ts';
import type { TnDataset, TnPool, TnShareAce, TnSmbShare } from '../truenas/types.ts';
import { CRYPTO_QUERY_PROPERTIES } from './datasets.ts';
import { afterFolderCreated, datasetCreateEncryption, decorateFolders, isEncryptionArtifact, validateNewFolderEncryption } from './encryption.ts';
import { LOCATION_DEFS } from './locations.ts';
import { lanIp } from './system.ts';
import { readUsers, type UserDirectory } from './users.ts';

/** Names ApexOs uses itself; personal folders can't take them. */
export const RESERVED_FOLDER_NAMES = ['Applications', 'ix-apps', 'homes', 'apexos-backups'];
const EVERYONE_SID = 'S-1-1-0';
/** BUILTIN\Administrators: the server's administrators always keep full access to private folders. */
const ADMINISTRATORS_SID = 'S-1-5-32-544';
export const FOLDER_PROPERTY = 'apexos:folder';

/**
 * Filesystem ACL applied to every folder: everyone who may connect can work with everything inside,
 * and the SMB share ACL decides who may connect and whether they can write (the HexOS model).
 */
export const STANDARD_ACL = [
  { tag: 'owner@', id: null, type: 'ALLOW', perms: { BASIC: 'FULL_CONTROL' }, flags: { BASIC: 'INHERIT' } },
  { tag: 'group@', id: null, type: 'ALLOW', perms: { BASIC: 'MODIFY' }, flags: { BASIC: 'INHERIT' } },
  { tag: 'everyone@', id: null, type: 'ALLOW', perms: { BASIC: 'MODIFY' }, flags: { BASIC: 'INHERIT' } },
];

interface FolderSources {
  datasets: TnDataset[];
  shares: TnSmbShare[];
  acls: Map<string, TnShareAce[]>;
  dir: UserDirectory;
  pools: TnPool[];
  ip: string | null;
}

async function readFolderSources(client: TrueNasClient): Promise<FolderSources> {
  const [datasets, shares, dir, pools, ip] = await Promise.all([
    client.call<TnDataset[]>('pool.dataset.query', [
      [['type', '=', 'FILESYSTEM']],
      { extra: { retrieve_children: false, properties: ['used', 'available', 'quota', 'mountpoint', ...CRYPTO_QUERY_PROPERTIES], retrieve_user_props: true } },
    ]),
    client.call<TnSmbShare[]>('sharing.smb.query'),
    readUsers(client),
    client.call<TnPool[]>('pool.query', [[], { select: ['id', 'name', 'path'] }]),
    lanIp(client),
  ]);
  const acls = new Map<string, TnShareAce[]>();
  await Promise.all(
    shares.map(async (s) => {
      const res = await client.call<{ share_acl: TnShareAce[] }>('sharing.smb.getacl', [{ share_name: s.name }]).catch(() => null);
      acls.set(s.name, res?.share_acl ?? []);
    }),
  );
  return { datasets, shares, acls, dir, pools, ip };
}

/** Top-level datasets of each pool (`pool/Name`) are folders, except TrueNAS/ApexOs internals. */
function isFolderDataset(ds: TnDataset): boolean {
  const parts = ds.id.split('/');
  if (parts.length !== 2) return false;
  const name = parts[1]!;
  // `apexos-backups` holds copies kept for other servers (services/backups.ts), not a folder of this one.
  return !name.startsWith('.') && !name.startsWith('ix-') && name !== 'apexos-backups';
}

function accessFromShare(share: TnSmbShare | undefined, acl: TnShareAce[], dir: UserDirectory): { access: Folder['access']; users: FolderUserAccess[] } {
  if (!share) return { access: 'private', users: [] };
  const guest = share.purpose === 'LEGACY_SHARE' && share.options?.guestok === true;
  const everyone = acl.some((a) => a.ae_who_sid === EVERYONE_SID && a.ae_type === 'ALLOWED');
  const users: FolderUserAccess[] = [];
  for (const ace of acl) {
    if (ace.ae_type !== 'ALLOWED' || ace.ae_who_id?.id_type !== 'USER' || ace.ae_who_id.id === dir.adminUid) continue;
    const user = dir.users.find((u) => u.uid === ace.ae_who_id!.id);
    if (!user) continue; // stale entry for a deleted user; cleaned on next save
    users.push({ username: user.username, level: ace.ae_perm === 'READ' ? 'read' : 'full' });
  }
  return { access: guest || everyone ? 'public' : 'private', users };
}

export function folderUses(ctx: AppContext, path: string): FolderUse[] {
  const state = ctx.store.get();
  const inside = (p: string | undefined) => !!p && (p === path || p.startsWith(`${path}/`));
  const uses: FolderUse[] = [];
  for (const def of LOCATION_DEFS) {
    if (inside(state.preferences.locations[def.id])) uses.push({ type: 'location', id: def.id, name: def.name });
  }
  for (const [name, app] of Object.entries(state.apps)) {
    const usesFolder =
      app.directories.some((d) => inside(d.path)) || app.locations.some((l) => inside(state.preferences.locations[l]));
    if (usesFolder) uses.push({ type: 'app', id: name, name });
  }
  return uses;
}

function toFolder(ctx: AppContext, ds: TnDataset, src: FolderSources): Folder {
  const path = ds.mountpoint ?? `/mnt/${ds.id}`;
  const share = src.shares.find((s) => s.path === path);
  const { access, users } = accessFromShare(share, share ? (src.acls.get(share.name) ?? []) : [], src.dir);
  const quota = propNumber(ds.quota);
  const usedBy = folderUses(ctx, path);
  const name = ds.id.split('/')[1]!;
  const pool = ds.pool ?? ds.id.split('/')[0]!;
  return {
    name,
    pool,
    poolDisplayName: ctx.store.get().poolNames[pool] ?? pool,
    dataset: ds.id,
    path,
    access,
    users,
    quotaBytes: quota > 0 ? quota : null,
    usedBytes: propNumber(ds.used),
    timeMachine: share?.purpose === 'TIMEMACHINE_SHARE',
    system: usedBy.some((u) => u.type === 'location') || RESERVED_FOLDER_NAMES.includes(name) || userProp(ds, FOLDER_PROPERTY) === 'system',
    usedBy,
    shared: Boolean(share?.enabled),
    smbUrl: share && src.ip ? `smb://${src.ip}/${encodeURIComponent(share.name)}` : null,
    uncPath: share && src.ip ? `\\\\${src.ip}\\${share.name}` : null,
  };
}

export async function listFolders(ctx: AppContext): Promise<FoldersResponse> {
  const src = await readFolderSources(ctx.truenas.client());
  const folders = src.datasets.filter((ds) => isFolderDataset(ds) && !isEncryptionArtifact(ctx, ds)).map((ds) => toFolder(ctx, ds, src));
  await decorateFolders(ctx, folders, src.datasets);
  folders.sort((a, b) => Number(a.system) - Number(b.system) || a.name.localeCompare(b.name));
  return { folders, reservedNames: RESERVED_FOLDER_NAMES };
}

export async function getFolder(ctx: AppContext, name: string): Promise<Folder> {
  const { folders } = await listFolders(ctx);
  const folder = folders.find((f) => f.name.toLowerCase() === name.toLowerCase());
  if (!folder) throw new UserError('Folder not found', 404, 'NOT_FOUND');
  return folder;
}

function shareAcl(access: Folder['access'], users: FolderUserAccess[], dir: UserDirectory, preserved: TnShareAce[]): TnShareAce[] {
  const acl: TnShareAce[] = [...preserved];
  if (access === 'public') {
    acl.push({ ae_who_sid: EVERYONE_SID, ae_perm: 'FULL', ae_type: 'ALLOWED' });
    return acl;
  }
  acl.push({ ae_who_sid: ADMINISTRATORS_SID, ae_perm: 'FULL', ae_type: 'ALLOWED' });
  // The admin account can only be named directly if it is an SMB user (TrueNAS must map it to a SID).
  const admin = dir.users.find((u) => u.uid === dir.adminUid);
  if (admin?.smb) acl.push({ ae_who_id: { id_type: 'USER', id: admin.uid }, ae_perm: 'FULL', ae_type: 'ALLOWED' });
  for (const u of users) {
    const user = dir.users.find((x) => x.username === u.username);
    if (!user) throw new UserError(`Unknown user ${u.username}`, 400, 'VALIDATION', { users: `Unknown user ${u.username}` });
    if (acl.some((a) => a.ae_type === 'DENIED' && a.ae_who_id?.id_type === 'USER' && a.ae_who_id.id === user.uid)) continue;
    acl.push({ ae_who_id: { id_type: 'USER', id: user.uid }, ae_perm: u.level === 'read' ? 'READ' : 'CHANGE', ae_type: 'ALLOWED' });
  }
  return acl;
}

function sharePurpose(access: Folder['access'], timeMachine: boolean): { purpose: string; options?: Record<string, unknown> } {
  if (timeMachine) return { purpose: 'TIMEMACHINE_SHARE' };
  // Guest access only exists on the legacy preset in TrueNAS 25.10.
  if (access === 'public') return { purpose: 'LEGACY_SHARE', options: { guestok: true } };
  return { purpose: 'DEFAULT_SHARE' };
}

function validateQuota(quotaBytes: number | null): number {
  if (quotaBytes === null || quotaBytes === 0) return 0;
  if (!Number.isFinite(quotaBytes) || quotaBytes < GiB) {
    throw new UserError('A storage limit must be at least 1 GiB.', 400, 'VALIDATION', { quotaBytes: 'At least 1 GiB' });
  }
  return Math.floor(quotaBytes);
}

function validateRequest(req: Pick<FolderRequest, 'access' | 'users' | 'timeMachine'>): void {
  if (req.access === 'public' && req.timeMachine) {
    throw new UserError('Time Machine folders must be private.', 400, 'VALIDATION', { timeMachine: 'Make the folder private first' });
  }
  if (req.access === 'public' && req.users.length) {
    throw new UserError('Public folders are open to everyone; per-user access only applies to private folders.', 400, 'VALIDATION');
  }
  const names = req.users.map((u) => u.username.toLowerCase());
  if (new Set(names).size !== names.length) throw new UserError('A user is listed twice.', 400, 'VALIDATION');
}

/**
 * Creates a share that only becomes visible once its permissions are in place: a new share starts with
 * TrueNAS's default "everyone, full access" ACL, so it is created disabled and enabled last.
 */
async function createShare(client: TrueNasClient, share: Record<string, unknown>, acl: TnShareAce[]): Promise<void> {
  const created = await client.call<TnSmbShare>('sharing.smb.create', [{ ...share, enabled: false, comment: 'Managed by ApexOs' }]);
  await client.call('sharing.smb.setacl', [{ share_name: created.name, share_acl: acl }]);
  await client.call('sharing.smb.update', [created.id, { enabled: true }]);
}

export async function ensureSmbService(client: TrueNasClient, opts: { timeMachine?: boolean } = {}): Promise<void> {
  if (opts.timeMachine) {
    const smb = await client.call<{ aapl_extensions: boolean }>('smb.config');
    if (!smb.aapl_extensions) await client.call('smb.update', [{ aapl_extensions: true }]);
  }
  const [svc] = await client.call<{ id: number; enable: boolean; state: string }[]>('service.query', [[['service', '=', 'cifs']]]);
  if (svc && !svc.enable) await client.call('service.update', ['cifs', { enable: true }]);
  if (!svc || svc.state !== 'RUNNING') {
    const ok = await client.job<boolean>('service.control', ['START', 'cifs', { silent: false }]);
    if (ok === false) throw new UserError('Could not start file sharing (SMB) on the server.', 502, 'SMB_START_FAILED');
  }
}

export interface CreateFolderOptions {
  /** Mark as a ApexOs-managed system folder (used for locations). */
  system?: boolean;
  /** Create the dataset without an SMB share. */
  noShare?: boolean;
  /** Dataset preset; apps folders use `APPS` so app containers (uid 568) can write. */
  shareType?: 'SMB' | 'APPS';
}

interface PreparedFolder {
  name: string;
  datasetId: string;
  path: string;
  quota: number;
  existing: TnDataset | undefined;
  shareTaken: TnSmbShare | undefined;
  src: FolderSources;
}

/** Validates a new folder against the server's current state; throws a UserError for bad input. */
export async function prepareFolder(ctx: AppContext, req: FolderRequest, opts: CreateFolderOptions = {}): Promise<PreparedFolder> {
  const name = req.name.trim();
  if (!foldernameFormat(name) || name.length > 80) {
    throw new UserError('Folder names use letters, numbers, spaces, dashes or underscores (up to 80), without leading or doubled separators.', 400, 'VALIDATION', {
      name: 'Invalid folder name',
    });
  }
  if (!opts.system && RESERVED_FOLDER_NAMES.some((r) => r.toLowerCase() === name.toLowerCase())) {
    throw new UserError(`"${name}" is reserved for ApexOs.`, 400, 'VALIDATION', { name: 'Reserved name' });
  }
  validateRequest(req);
  const quota = validateQuota(req.quotaBytes);
  const src = await readFolderSources(ctx.truenas.client());
  const pool = src.pools.find((p) => p.name === req.pool);
  if (!pool) throw new UserError('Pick a pool for the folder.', 400, 'VALIDATION', { pool: 'Unknown pool' });
  const datasetId = `${pool.name}/${name}`;
  const path = `${pool.path}/${name}`;
  const existing = src.datasets.find((d) => d.id.toLowerCase() === datasetId.toLowerCase());
  const shareTaken = src.shares.find((s) => s.name.toLowerCase() === name.toLowerCase());
  if (shareTaken && shareTaken.path !== path) {
    throw new UserError(`A shared folder named "${shareTaken.name}" already exists.`, 409, 'VALIDATION', { name: 'Already in use' });
  }
  if (existing && src.shares.some((s) => s.path === path) && !opts.system) {
    throw new UserError(`A folder named "${name}" already exists on ${pool.name}.`, 409, 'VALIDATION', { name: 'Already exists' });
  }
  for (const u of req.users) {
    if (!src.dir.users.some((x) => x.username === u.username)) {
      throw new UserError(`Unknown user ${u.username}`, 400, 'VALIDATION', { users: `Unknown user ${u.username}` });
    }
  }
  if (!existing) await validateNewFolderEncryption(ctx, pool.name, req.encryption);
  return { name, datasetId, path, quota, existing, shareTaken, src };
}

/** Creates the dataset, permissions and share. Resumes if the dataset already exists. */
export async function createFolder(
  ctx: AppContext,
  req: FolderRequest,
  opts: CreateFolderOptions = {},
  step: <T>(name: string, fn: () => Promise<T>) => Promise<T> = (_n, fn) => fn(),
): Promise<void> {
  const client = ctx.truenas.client();
  const { name, datasetId, path, quota, existing, shareTaken, src } = await prepareFolder(ctx, req, opts);

  if (!existing) {
    await step('Creating the folder', () =>
      client.call('pool.dataset.create', [
        {
          name: datasetId,
          type: 'FILESYSTEM',
          share_type: opts.shareType ?? 'SMB',
          quota: quota || null,
          user_properties: [{ key: FOLDER_PROPERTY, value: opts.system ? 'system' : 'true' }],
          ...datasetCreateEncryption(req.encryption),
        },
      ]),
    );
    await afterFolderCreated(ctx, datasetId, req.encryption);
  }
  if (opts.shareType !== 'APPS') {
    await step('Setting permissions', () =>
      client.job('filesystem.setacl', [{ path, acltype: 'NFS4', dacl: STANDARD_ACL, options: { recursive: false, canonicalize: true } }]),
    );
  }
  if (opts.noShare) return;
  await step('Sharing on your network', async () => {
    const { purpose, options } = sharePurpose(req.access, req.timeMachine);
    await ensureSmbService(client, { timeMachine: req.timeMachine });
    const acl = shareAcl(req.access, req.users, src.dir, []);
    if (shareTaken) await client.call('sharing.smb.setacl', [{ share_name: shareTaken.name, share_acl: acl }]);
    else await createShare(client, { name, path, purpose, ...(options ? { options } : {}) }, acl);
  });
  ctx.bus.changed('folders');
}

export async function updateFolder(
  ctx: AppContext,
  name: string,
  req: Omit<FolderRequest, 'name' | 'pool'>,
  step: <T>(name: string, fn: () => Promise<T>) => Promise<T> = (_n, fn) => fn(),
): Promise<void> {
  const client = ctx.truenas.client();
  validateRequest(req);
  const quota = validateQuota(req.quotaBytes);
  const folder = await getFolder(ctx, name);
  const src = await readFolderSources(client);
  const share = src.shares.find((s) => s.path === folder.path);

  if ((folder.quotaBytes ?? 0) !== quota) {
    await step('Updating the storage limit', () => client.call('pool.dataset.update', [folder.dataset, { quota: quota || 0 }]));
  }
  // Saving also repairs the folder's own top-level permissions.
  await step('Checking permissions', () =>
    client.job('filesystem.setacl', [{ path: folder.path, acltype: 'NFS4', dacl: STANDARD_ACL, options: { recursive: false, canonicalize: true } }]),
  );
  await step('Updating sharing', async () => {
    const { purpose, options } = sharePurpose(req.access, req.timeMachine);
    await ensureSmbService(client, { timeMachine: req.timeMachine });
    if (!share) {
      await createShare(
        client,
        { name: folder.name, path: folder.path, purpose, ...(options ? { options } : {}) },
        shareAcl(req.access, req.users, src.dir, []),
      );
      return;
    }
    // Preserve DENY entries and principals ApexOs doesn't manage (e.g. groups or SIDs set in TrueNAS),
    // drop entries for deleted users, and rebuild the allow list.
    const current = src.acls.get(share.name) ?? [];
    const knownUids = new Set(src.dir.users.map((u) => u.uid));
    const preserved = current
      .filter((a) => {
        // Local-account SIDs that no longer resolve belong to deleted users: always clean them up.
        if (!a.ae_who_id && a.ae_who_sid?.startsWith('S-1-5-21-')) return false;
        if (a.ae_type === 'DENIED') return a.ae_who_id?.id_type !== 'USER' || knownUids.has(a.ae_who_id.id);
        if (a.ae_who_sid === EVERYONE_SID || a.ae_who_sid === ADMINISTRATORS_SID) return false;
        if (a.ae_who_id?.id_type === 'USER') return false;
        return Boolean(a.ae_who_sid || a.ae_who_id);
      })
      .map((a): TnShareAce => (a.ae_who_sid ? { ae_perm: a.ae_perm, ae_type: a.ae_type, ae_who_sid: a.ae_who_sid } : a));
    const acl = shareAcl(req.access, req.users, src.dir, preserved);
    const purposeChanged = share.purpose !== purpose || (purpose === 'LEGACY_SHARE' && share.options?.guestok !== true);
    const merged = purpose === share.purpose ? { ...share.options, ...options } : options;
    const update = { purpose, ...(merged ? { options: merged } : {}), enabled: true };
    // Tighten access before loosening it so a failure half-way never leaves the folder more open than requested.
    if (req.access === 'private') {
      await client.call('sharing.smb.setacl', [{ share_name: share.name, share_acl: acl }]);
      if (purposeChanged || !share.enabled) await client.call('sharing.smb.update', [share.id, update]);
    } else {
      if (purposeChanged || !share.enabled) await client.call('sharing.smb.update', [share.id, update]);
      await client.call('sharing.smb.setacl', [{ share_name: share.name, share_acl: acl }]);
    }
  });
  ctx.bus.changed('folders');
}

export async function deleteFolder(ctx: AppContext, name: string, confirmName: string): Promise<void> {
  const folder = await getFolder(ctx, name);
  if (confirmName.trim() !== folder.name) throw new UserError('Type the folder name exactly to confirm.', 400, 'VALIDATION', { confirmName: 'Does not match' });
  if (folder.usedBy.length) {
    throw new UserError(`This folder is in use by ${folder.usedBy.map((u) => u.name).join(', ')}.`, 409, 'IN_USE');
  }
  const client = ctx.truenas.client();
  const shares = await client.call<TnSmbShare[]>('sharing.smb.query', [[['path', '=', folder.path]]]);
  for (const s of shares) await client.call('sharing.smb.delete', [s.id]);
  await client.call('pool.dataset.delete', [folder.dataset, { recursive: true, force: true }]);
  ctx.bus.changed('folders');
}
