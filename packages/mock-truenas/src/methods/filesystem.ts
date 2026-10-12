import type { Mock } from '../context.ts';
import { callError, queryFilter, validationError, validationErrors } from '../rpc.ts';
import type { AclState, MockState } from '../state.ts';
import {
  datasetAtPath,
  datasetAvailable,
  datasetContaining,
  defaultAcl,
  effectiveAcl,
  mountpoint,
  normPath,
  ownerOf,
  pathKind,
  poolAllocated,
  poolSize,
  resolveProp,
} from '../storage.ts';
import { argObj, isObj, seeded, type Obj } from '../util.ts';

const NFS_BASIC = ['FULL_CONTROL', 'MODIFY', 'READ', 'TRAVERSE'];
const NFS_TAGS = ['owner@', 'group@', 'everyone@', 'USER', 'GROUP'];
const POSIX_TAGS = ['USER_OBJ', 'GROUP_OBJ', 'OTHER', 'MASK', 'USER', 'GROUP'];

function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

function userName(state: MockState, uid: number): string | null {
  return state.users.find((u) => u.uid === uid)?.username ?? null;
}

function groupName(state: MockState, gid: number): string | null {
  return state.groups.find((g) => g.gid === gid)?.name ?? null;
}

function requirePath(state: MockState, raw: unknown, attr: string): string {
  if (typeof raw !== 'string' || !raw.startsWith('/')) throw validationError(attr, 'Path must be an absolute path');
  const p = normPath(raw);
  if (!pathKind(state, p)) throw callError('ENOENT', `Path ${p} not found`);
  return p;
}

function childrenOf(state: MockState, path: string): string[] {
  const out = new Set<string>();
  if (path === '/') out.add('/mnt');
  for (const ds of state.datasets) {
    if (ds.type !== 'FILESYSTEM') continue;
    const mp = mountpoint(ds);
    if (dirname(mp) === path) out.add(mp);
  }
  for (const n of state.fs.nodes) if (dirname(n.path) === path) out.add(n.path);
  return [...out].sort();
}

function fsEntry(state: MockState, path: string): Obj {
  const kind = pathKind(state, path)!;
  const own = ownerOf(state, path);
  const node = state.fs.nodes.find((n) => n.path === path);
  const ds = datasetContaining(state, path);
  const isMount = !!datasetAtPath(state, path) || path === '/';
  const size = kind === 'FILE' ? (node?.size ?? 0) : childrenOf(state, path).length + 2;
  const acl = path.startsWith('/mnt/') ? !effectiveAcl(state, path).trivial : false;
  return {
    name: path === '/' ? '/' : path.slice(path.lastIndexOf('/') + 1),
    path,
    realpath: path,
    type: kind,
    size,
    allocation_size: kind === 'FILE' ? Math.ceil(size / 4096) * 4096 : 512,
    mode: (kind === 'DIRECTORY' ? 0o40000 : 0o100000) | own.mode,
    mount_id: ds ? Math.floor(seeded(ds.id) * 10000) + 100 : 30,
    acl,
    uid: own.uid,
    gid: own.gid,
    is_mountpoint: isMount,
    is_ctldir: false,
    attributes: [],
    xattrs: [],
    zfs_attrs: ds ? ['ARCHIVE'] : null,
  };
}

function getAcl(state: MockState, path: string, resolveIds: boolean): Obj {
  const acl = effectiveAcl(state, path);
  const own = ownerOf(state, path);
  const entries = acl.acl.map((e) => {
    const out = { ...e };
    if (resolveIds && typeof e.id === 'number' && e.id >= 0) {
      out.who = e.tag === 'USER' ? userName(state, e.id) : e.tag === 'GROUP' ? groupName(state, e.id) : null;
    }
    return out;
  });
  return {
    path,
    user: userName(state, own.uid),
    group: groupName(state, own.gid),
    uid: own.uid,
    gid: own.gid,
    acltype: acl.acltype,
    acl: entries,
    ...(acl.acltype === 'NFS4' ? { aclflags: acl.aclflags ?? { autoinherit: false, protected: false, defaulted: false } } : {}),
    trivial: acl.trivial,
  };
}

function resolveOwner(state: MockState, data: Obj, attr: string, errors: Array<[string, string]>): { uid?: number; gid?: number } {
  const out: { uid?: number; gid?: number } = {};
  if (typeof data.uid === 'number') out.uid = data.uid;
  if (typeof data.gid === 'number') out.gid = data.gid;
  if (typeof data.user === 'string') {
    const u = state.users.find((x) => x.username === data.user);
    if (!u) errors.push([`${attr}.user`, `${data.user}: user does not exist`]);
    else out.uid = u.uid;
  }
  if (typeof data.group === 'string') {
    const g = state.groups.find((x) => x.name === data.group);
    if (!g) errors.push([`${attr}.group`, `${data.group}: group does not exist`]);
    else out.gid = g.gid;
  }
  return out;
}

function descendantsOfPath(state: MockState, path: string): string[] {
  const prefix = `${path}/`;
  return [...Object.keys(state.fs.acls), ...Object.keys(state.fs.owners)].filter((p) => p.startsWith(prefix));
}

function nfsAce(tag: string, basic: string, id: number | null = null, inherit = 'INHERIT'): Obj {
  return { tag, id: id ?? -1, type: 'ALLOW', perms: { BASIC: basic }, flags: { BASIC: inherit } };
}

function posixAce(tag: string, r: boolean, w: boolean, x: boolean, isDefault = false, id = -1): Obj {
  return { tag, id, perms: { READ: r, WRITE: w, EXECUTE: x }, default: isDefault };
}

export function aclTemplates(): Obj[] {
  const posixPair = (perms: [boolean, boolean, boolean][]) => {
    const tags = ['USER_OBJ', 'GROUP_OBJ', 'OTHER'];
    return [
      ...tags.map((t, i) => posixAce(t, ...perms[i]!)),
      ...tags.map((t, i) => posixAce(t, ...perms[i]!, true)),
    ];
  };
  return [
    { id: 1, builtin: true, name: 'NFS4_OPEN', acltype: 'NFS4', comment: '', acl: [nfsAce('owner@', 'FULL_CONTROL'), nfsAce('group@', 'MODIFY'), nfsAce('everyone@', 'MODIFY')] },
    { id: 2, builtin: true, name: 'NFS4_RESTRICTED', acltype: 'NFS4', comment: '', acl: [nfsAce('owner@', 'FULL_CONTROL'), nfsAce('group@', 'MODIFY')] },
    {
      id: 3,
      builtin: true,
      name: 'NFS4_HOME',
      acltype: 'NFS4',
      comment: '',
      acl: [nfsAce('owner@', 'FULL_CONTROL'), nfsAce('group@', 'MODIFY'), nfsAce('everyone@', 'TRAVERSE', null, 'NOINHERIT')],
    },
    {
      id: 4,
      builtin: true,
      name: 'NFS4_ADMIN',
      acltype: 'NFS4',
      comment: '',
      acl: [nfsAce('owner@', 'FULL_CONTROL'), nfsAce('group@', 'FULL_CONTROL'), nfsAce('GROUP', 'FULL_CONTROL', 544)],
    },
    { id: 5, builtin: true, name: 'POSIX_OPEN', acltype: 'POSIX1E', comment: '', acl: posixPair([[true, true, true], [true, true, true], [true, true, true]]) },
    { id: 6, builtin: true, name: 'POSIX_RESTRICTED', acltype: 'POSIX1E', comment: '', acl: posixPair([[true, true, true], [true, true, true], [false, false, false]]) },
    { id: 7, builtin: true, name: 'POSIX_HOME', acltype: 'POSIX1E', comment: '', acl: posixPair([[true, true, true], [true, false, true], [true, false, true]]) },
    {
      id: 8,
      builtin: true,
      name: 'POSIX_ADMIN',
      acltype: 'POSIX1E',
      comment: '',
      acl: [...posixPair([[true, true, true], [true, true, true], [false, false, false]]), posixAce('GROUP', true, true, true, false, 544), posixAce('MASK', true, true, true)],
    },
  ];
}

function normalizeDacl(state: MockState, raw: unknown, acltype: 'NFS4' | 'POSIX1E', attr: string): Obj[] {
  if (!Array.isArray(raw)) throw validationError(`${attr}.dacl`, 'Input should be a valid list');
  const errors: Array<[string, string]> = [];
  const out: Obj[] = [];
  raw.forEach((e: unknown, i) => {
    const a = `${attr}.dacl.${i}`;
    if (!isObj(e)) return void errors.push([a, 'Input should be a valid dictionary']);
    const tag = String(e.tag);
    const tags = acltype === 'NFS4' ? NFS_TAGS : POSIX_TAGS;
    if (!tags.includes(tag)) return void errors.push([`${a}.tag`, `Input should be ${tags.map((t) => `'${t}'`).join(', ')}`]);
    let id = typeof e.id === 'number' ? e.id : -1;
    if (tag === 'USER' || tag === 'GROUP') {
      if (typeof e.who === 'string' && e.who) {
        const found = tag === 'USER' ? state.users.find((u) => u.username === e.who)?.uid : state.groups.find((g) => g.name === e.who)?.gid;
        if (found === undefined) return void errors.push([`${a}.who`, `${e.who}: ${tag === 'USER' ? 'user' : 'group'} does not exist`]);
        id = found;
      } else if (id < 0) return void errors.push([`${a}.id`, `${tag} entries require an id or who`]);
    }
    if (acltype === 'NFS4') {
      if (!['ALLOW', 'DENY'].includes(String(e.type))) return void errors.push([`${a}.type`, "Input should be 'ALLOW' or 'DENY'"]);
      const perms = isObj(e.perms) ? e.perms : {};
      if ('BASIC' in perms && !NFS_BASIC.includes(String(perms.BASIC))) return void errors.push([`${a}.perms.BASIC`, `Input should be ${NFS_BASIC.map((b) => `'${b}'`).join(', ')}`]);
      out.push({ tag, id, type: e.type, perms, flags: isObj(e.flags) ? e.flags : { BASIC: 'INHERIT' } });
    } else {
      const perms = isObj(e.perms) ? e.perms : {};
      if (['READ', 'WRITE', 'EXECUTE'].some((k) => typeof perms[k] !== 'boolean')) return void errors.push([`${a}.perms`, 'READ, WRITE and EXECUTE must be booleans']);
      out.push({ tag, id, perms, default: e.default === true });
    }
  });
  if (errors.length) throw validationErrors(errors);
  return out;
}

export function registerFilesystem(mock: Mock): void {
  const { server } = mock;

  server.method('filesystem.stat', (p) => {
    const { state } = mock;
    const path = requirePath(state, p[0], 'filesystem.stat.path');
    const e = fsEntry(state, path);
    const node = state.fs.nodes.find((n) => n.path === path);
    const ds = datasetAtPath(state, path);
    const t = (node?.mtime ?? ds?.createdAt ?? mock.bootTime) / 1000;
    return {
      realpath: path,
      type: e.type,
      size: e.size,
      allocation_size: e.allocation_size,
      mode: e.mode,
      mount_id: e.mount_id,
      uid: e.uid,
      gid: e.gid,
      atime: t,
      mtime: t,
      ctime: t,
      btime: t,
      dev: e.mount_id,
      inode: Math.floor(seeded(path) * 100000) + 34,
      nlink: e.type === 'DIRECTORY' ? 2 : 1,
      acl: e.acl,
      is_mountpoint: e.is_mountpoint,
      is_ctldir: false,
      attributes: [],
      user: userName(state, e.uid as number),
      group: groupName(state, e.gid as number),
    };
  });

  server.method('filesystem.listdir', (p) => {
    const { state } = mock;
    const path = requirePath(state, p[0], 'filesystem.listdir.path');
    if (pathKind(state, path) !== 'DIRECTORY') throw callError('ENOTDIR', `${path}: not a directory`);
    return queryFilter(childrenOf(state, path).map((c) => fsEntry(state, c)), p[1] ?? [], p[2] ?? {});
  });

  server.method('filesystem.mkdir', (p) => {
    const { state } = mock;
    const data = typeof p[0] === 'string' ? { path: p[0], options: p[1] } : argObj(p[0], 'filesystem_mkdir');
    if (typeof data.path !== 'string' || !data.path.startsWith('/')) throw validationError('filesystem_mkdir.path', 'Path must be an absolute path');
    const path = normPath(data.path);
    if (!path.startsWith('/mnt/') || path.split('/').length < 4 || !datasetContaining(state, path)) {
      throw validationError('filesystem_mkdir.path', 'Directories may only be created inside a dataset under /mnt/<pool>.');
    }
    if (pathKind(state, path)) throw callError('EEXIST', `${path}: path already exists`);
    if (pathKind(state, dirname(path)) !== 'DIRECTORY') throw callError('ENOENT', `${dirname(path)}: parent directory does not exist`);
    const opts = isObj(data.options) ? data.options : {};
    const mode = typeof opts.mode === 'string' ? parseInt(opts.mode, 8) : 0o755;
    state.fs.nodes.push({ path, type: 'DIRECTORY', size: 2, mtime: Date.now() });
    const parentOwner = ownerOf(state, dirname(path));
    state.fs.owners[path] = { uid: parentOwner.uid, gid: parentOwner.gid, mode: Number.isNaN(mode) ? 0o755 : mode };
    return fsEntry(state, path);
  });

  server.method('filesystem.getacl', (p) => {
    const path = requirePath(mock.state, p[0], 'filesystem.getacl.path');
    return getAcl(mock.state, path, p[2] === true);
  });

  server.method('filesystem.statfs', (p) => {
    const { state } = mock;
    const path = requirePath(state, p[0], 'filesystem.statfs.path');
    const ds = datasetContaining(state, path);
    const pool = ds ? state.pools.find((x) => x.name === ds.pool) : undefined;
    const total = pool ? poolSize(state, pool) : 0;
    const avail = ds ? datasetAvailable(state, ds) : 0;
    const used = pool ? poolAllocated(state, pool) : 0;
    const nfs = ds ? resolveProp(state, ds, 'acltype').value === 'NFSV4' : false;
    return {
      flags: ['RW', 'NOATIME', 'XATTR', nfs ? 'NFS4ACL' : 'POSIXACL', 'CASESENSITIVE'],
      fstype: ds ? 'zfs' : 'tmpfs',
      source: ds?.id ?? 'tmpfs',
      dest: ds ? mountpoint(ds) : path,
      blocksize: 131072,
      total_blocks: Math.floor(total / 131072),
      free_blocks: Math.floor((total - used) / 131072),
      avail_blocks: Math.floor(avail / 131072),
      files: 1000000,
      free_files: 999000,
      name_max: 255,
      fsid: [String(Math.floor(seeded(path) * 1e9))],
      total_bytes: total,
      free_bytes: Math.max(0, total - used),
      avail_bytes: avail,
    };
  });

  server.job('filesystem.setacl', async (p, job) => {
    const { state } = mock;
    const data = argObj(p[0], 'filesystem_acl');
    const path = requirePath(state, data.path, 'filesystem_acl.path');
    if (!path.startsWith('/mnt/') || !datasetContaining(state, path)) throw validationError('filesystem_acl.path', 'ACLs may only be set on paths inside a pool dataset.');
    const def = defaultAcl(state, path);
    const opts = isObj(data.options) ? data.options : {};
    const errors: Array<[string, string]> = [];
    const owner = resolveOwner(state, data, 'filesystem_acl', errors);
    if (errors.length) throw validationErrors(errors);
    if (data.acltype !== undefined && data.acltype !== null && data.acltype !== def.acltype) {
      throw validationError('filesystem_acl.acltype', `ACL type mismatch: the dataset uses ${def.acltype === 'NFS4' ? 'NFSv4' : 'POSIX'} ACLs.`);
    }
    job.progress(20, 'Validating ACL');
    if (opts.stripacl === true) {
      delete state.fs.acls[path];
    } else {
      const dacl = normalizeDacl(state, data.dacl, def.acltype, 'filesystem_acl');
      const trivial = def.acltype === 'POSIX1E' && dacl.every((e) => ['USER_OBJ', 'GROUP_OBJ', 'OTHER'].includes(String(e.tag)) && !e.default);
      const acl: AclState = {
        acltype: def.acltype,
        acl: dacl,
        aclflags: def.acltype === 'NFS4' ? { autoinherit: false, protected: false, defaulted: false, ...(isObj(data.nfs41_flags) ? data.nfs41_flags : {}) } : null,
        trivial,
      };
      state.fs.acls[path] = acl;
    }
    if (owner.uid !== undefined || owner.gid !== undefined) {
      const cur = ownerOf(state, path);
      state.fs.owners[path] = { uid: owner.uid ?? cur.uid, gid: owner.gid ?? cur.gid, mode: cur.mode };
    }
    if (opts.recursive === true) {
      for (const d of descendantsOfPath(state, path)) delete state.fs.acls[d];
      job.progress(60, 'Applying ACL recursively');
      await job.sleep();
    }
    job.progress(90, 'Setting ACL');
    await job.sleep();
    return getAcl(state, path, false);
  });

  const permJob = (attr: string, withMode: boolean) => async (p: unknown[], job: { progress(n: number, d?: string): void; sleep(u?: number): Promise<void> }) => {
    const { state } = mock;
    const data = argObj(p[0], attr);
    const path = requirePath(state, data.path, `${attr}.path`);
    if (!path.startsWith('/mnt/') || !datasetContaining(state, path)) throw validationError(`${attr}.path`, 'Permissions may only be changed inside a pool dataset.');
    const opts = isObj(data.options) ? data.options : {};
    const errors: Array<[string, string]> = [];
    const owner = resolveOwner(state, data, attr, errors);
    let mode: number | undefined;
    if (withMode && data.mode !== undefined && data.mode !== null) {
      mode = typeof data.mode === 'string' ? parseInt(data.mode, 8) : NaN;
      if (Number.isNaN(mode) || mode < 0 || mode > 0o7777) errors.push([`${attr}.mode`, 'Invalid mode']);
      else if (!effectiveAcl(state, path).trivial && opts.stripacl !== true) {
        errors.push([`${attr}.mode`, `Non-trivial ACL present on [${path}]. Set "stripacl" to remove the ACL before setting a mode.`]);
      }
    }
    if (errors.length) throw validationErrors(errors);
    job.progress(30, withMode ? 'Setting permissions' : 'Changing ownership');
    const targets = [path, ...(opts.recursive === true ? descendantsOfPath(state, path) : [])];
    for (const t of targets) {
      const cur = ownerOf(state, t);
      state.fs.owners[t] = { uid: owner.uid ?? cur.uid, gid: owner.gid ?? cur.gid, mode: mode ?? cur.mode };
      if (opts.stripacl === true) {
        const def = defaultAcl(state, t);
        if (def.acltype === 'NFS4') {
          state.fs.acls[t] = {
            acltype: 'NFS4',
            acl: [nfsAce('owner@', 'FULL_CONTROL', null, 'NOINHERIT'), nfsAce('group@', 'MODIFY', null, 'NOINHERIT'), nfsAce('everyone@', 'READ', null, 'NOINHERIT')],
            aclflags: { autoinherit: false, protected: false, defaulted: false },
            trivial: true,
          };
        } else delete state.fs.acls[t];
      }
    }
    await job.sleep();
    return null;
  };
  server.job('filesystem.setperm', permJob('filesystem.setperm', true));
  server.job('filesystem.chown', permJob('filesystem.chown', false));

  server.method('filesystem.acltemplate.query', (p) => queryFilter(aclTemplates(), p[0], p[1]));
  server.method('filesystem.acltemplate.by_path', (p) => {
    const data = argObj(p[0], 'filesystem_acltemplate_by_path');
    const path = typeof data.path === 'string' ? normPath(data.path) : '';
    const acltype = path && pathKind(mock.state, path) ? defaultAcl(mock.state, path).acltype : null;
    const list = aclTemplates().filter((t) => !acltype || t.acltype === acltype);
    return queryFilter(list, data['query-filters'] ?? [], data['query-options'] ?? {});
  });
  server.method('filesystem.default_acl_choices', () => aclTemplates().map((t) => t.name));
}
