import type { ShareUser } from '@apexos/api-types';
import type { TrueNasClient } from '@apexos/truenas-client';
import type { AppContext } from '../app.ts';
import { UserError } from '../lib/errors.ts';
import { usernameFormat } from '../lib/validators.ts';
import type { TnShareAce, TnSmbShare, TnUser } from '../truenas/types.ts';

/** Accounts ApexOs creates for its own purposes are never shown as share users. */
const HIDDEN_PREFIXES = ['apexos_'];

export interface UserDirectory {
  /** The TrueNAS account ApexOs is connected as (treated as the owner/admin). */
  adminUid: number | null;
  adminUsername: string | null;
  /** Non-builtin local users, including the admin. */
  users: TnUser[];
}

export async function readUsers(client: TrueNasClient): Promise<UserDirectory> {
  const [me, users] = await Promise.all([
    client.call<{ pw_uid: number; pw_name: string }>('auth.me').catch(() => null),
    client.call<TnUser[]>('user.query', [[['builtin', '=', false]]]),
  ]);
  return { adminUid: me?.pw_uid ?? null, adminUsername: me?.pw_name ?? null, users };
}

export function isShareUser(u: TnUser, dir: UserDirectory): boolean {
  if (u.uid === dir.adminUid) return false;
  if (HIDDEN_PREFIXES.some((p) => u.username.startsWith(p))) return false;
  return u.smb && !u.roles?.includes('FULL_ADMIN');
}

export async function listUsers(ctx: AppContext): Promise<ShareUser[]> {
  const client = ctx.truenas.client();
  const [dir, shares] = await Promise.all([readUsers(client), client.call<TnSmbShare[]>('sharing.smb.query')]);
  const acls = await Promise.all(
    shares.map((s) =>
      client
        .call<{ share_acl: TnShareAce[] }>('sharing.smb.getacl', [{ share_name: s.name }])
        .then((r) => ({ share: s, acl: r.share_acl }))
        .catch(() => ({ share: s, acl: [] as TnShareAce[] })),
    ),
  );
  return dir.users
    .filter((u) => isShareUser(u, dir))
    .map((u) => ({
      id: u.id,
      uid: u.uid,
      username: u.username,
      folders: acls.flatMap(({ share, acl }) => {
        const everyone = acl.some((a) => a.ae_who_sid === 'S-1-1-0' && a.ae_type === 'ALLOWED');
        const denied = acl.some((a) => a.ae_who_id?.id_type === 'USER' && a.ae_who_id.id === u.uid && a.ae_type === 'DENIED');
        const entry = acl.find((a) => a.ae_who_id?.id_type === 'USER' && a.ae_who_id.id === u.uid && a.ae_type === 'ALLOWED');
        if (denied) return [];
        if (entry) return [{ name: share.name, level: entry.ae_perm === 'READ' ? ('read' as const) : ('full' as const) }];
        if (everyone) return [{ name: share.name, level: 'full' as const }];
        return [];
      }),
    }))
    .sort((a, b) => a.username.localeCompare(b.username));
}

function validatePassword(password: string): void {
  if (password.length < 8 || password.length > 128) {
    throw new UserError('Use 8 to 128 characters for the password.', 400, 'VALIDATION', { password: 'Use 8 to 128 characters' });
  }
}

function validateUsername(username: string, dir: UserDirectory, exceptId?: number): void {
  if (!usernameFormat(username)) {
    throw new UserError('Usernames are 3–30 characters: letters, numbers, dashes or underscores, starting with a letter.', 400, 'VALIDATION', {
      username: 'Invalid username',
    });
  }
  if (HIDDEN_PREFIXES.some((p) => username.startsWith(p))) {
    throw new UserError('That name is reserved.', 400, 'VALIDATION', { username: 'Reserved name' });
  }
  if (dir.users.some((u) => u.username.toLowerCase() === username.toLowerCase() && u.id !== exceptId)) {
    throw new UserError('That username is already taken.', 409, 'VALIDATION', { username: 'Already taken' });
  }
}

export async function createUser(ctx: AppContext, username: string, password: string): Promise<ShareUser> {
  const client = ctx.truenas.client();
  const dir = await readUsers(client);
  validateUsername(username, dir);
  validatePassword(password);
  // Each user gets a primary group of the same name. A leftover empty group with that name (e.g. from an
  // account deleted in TrueNAS without its group) is reused rather than failing.
  const [existingGroup] = await client.call<{ id: number; users: number[]; builtin: boolean }[]>('group.query', [[['name', '=', username]]]);
  if (existingGroup && (existingGroup.builtin || existingGroup.users.length)) {
    throw new UserError('That name is already used by a group on the server.', 409, 'VALIDATION', { username: 'Already taken' });
  }
  await client.call<TnUser>('user.create', [
    {
      username,
      full_name: username,
      password,
      ...(existingGroup ? { group: existingGroup.id } : { group_create: true }),
      smb: true,
      home: '/var/empty',
      shell: '/usr/sbin/nologin',
    },
  ]);
  ctx.bus.changed('users');
  const created = (await listUsers(ctx)).find((u) => u.username === username);
  if (!created) throw new UserError('The user was created but could not be read back', 500, 'INTERNAL');
  return created;
}

async function findShareUser(client: TrueNasClient, id: number): Promise<{ dir: UserDirectory; user: TnUser }> {
  const dir = await readUsers(client);
  const user = dir.users.find((u) => u.id === id);
  if (!user || !isShareUser(user, dir)) throw new UserError('User not found', 404, 'NOT_FOUND');
  return { dir, user };
}

export async function updateUser(ctx: AppContext, id: number, changes: { username?: string; password?: string }): Promise<ShareUser> {
  const client = ctx.truenas.client();
  const { dir, user } = await findShareUser(client, id);
  const patch: Record<string, unknown> = {};
  if (changes.username !== undefined && changes.username !== user.username) {
    validateUsername(changes.username, dir, id);
    patch.username = changes.username;
    patch.full_name = changes.username;
  }
  if (changes.password) {
    validatePassword(changes.password);
    patch.password = changes.password;
  }
  if (Object.keys(patch).length) await client.call('user.update', [id, patch]);
  // Keep the primary group's name in step with the username so the old name is free again.
  if (patch.username && user.group && user.group.bsdgrp_group === user.username) {
    await client.call('group.update', [user.group.id, { name: patch.username }]).catch(() => undefined);
  }
  ctx.bus.changed('users');
  const updated = (await listUsers(ctx)).find((u) => u.id === id);
  if (!updated) throw new UserError('User not found', 404, 'NOT_FOUND');
  return updated;
}

export async function deleteUser(ctx: AppContext, id: number): Promise<void> {
  const client = ctx.truenas.client();
  const { user } = await findShareUser(client, id);
  await client.call('user.delete', [id, { delete_group: true }]);
  // Remove the user's entries from share ACLs so shares stay readable on every TrueNAS version.
  const shares = await client.call<TnSmbShare[]>('sharing.smb.query');
  for (const share of shares) {
    const { share_acl } = await client.call<{ share_acl: TnShareAce[] }>('sharing.smb.getacl', [{ share_name: share.name }]);
    const kept = share_acl.filter((a) => !(a.ae_who_id?.id_type === 'USER' && a.ae_who_id.id === user.uid));
    if (kept.length !== share_acl.length) await client.call('sharing.smb.setacl', [{ share_name: share.name, share_acl: kept }]);
  }
  ctx.bus.changed('users');
  ctx.bus.changed('folders');
}
