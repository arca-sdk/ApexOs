import type { Mock } from '../context.ts';
import { callError, queryFilter, validationErrors } from '../rpc.ts';
import type { GroupState, MockState, UserState } from '../state.ts';
import { datasetContaining, normPath, pathKind } from '../storage.ts';
import { $date, argObj, isObj, randomString, type Obj } from '../util.ts';

const USERNAME_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*\$?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FIRST_UID = 3000;
/** Domain RIDs used for the builtin SMB groups (DomainRid.ADMINS / GUESTS). */
const BUILTIN_RIDS: Record<string, number> = { builtin_administrators: 512, builtin_guests: 514 };

export function groupById(state: MockState, id: number): GroupState | undefined {
  return state.groups.find((g) => g.id === id);
}

/** Local SMB users get `<server sid>-<20000 + db id>`; non-SMB accounts have no SID. */
export function userSid(state: MockState, u: UserState): string | null {
  return u.smb ? `${String(state.smb.server_sid)}-${20000 + u.id}` : null;
}

/** Local SMB groups get `<server sid>-<200000 + db id>`; builtin admins/guests use domain RIDs 512/514. */
export function groupSid(state: MockState, g: GroupState): string | null {
  const rid = BUILTIN_RIDS[g.name];
  if (rid !== undefined) return `${String(state.smb.server_sid)}-${rid}`;
  return g.smb ? `${String(state.smb.server_sid)}-${200000 + g.id}` : null;
}

export function userRoles(state: MockState, u: UserState): string[] {
  const roles = new Set<string>();
  for (const gid of [u.group, ...u.groups]) for (const r of groupById(state, gid)?.roles ?? []) roles.add(r);
  return [...roles];
}

export function renderUser(state: MockState, u: UserState): Obj {
  const g = groupById(state, u.group);
  return {
    id: u.id,
    uid: u.uid,
    username: u.username,
    unixhash: u.password ? '********' : '*',
    smbhash: u.smb && u.password ? '********' : '*',
    home: u.home,
    shell: u.shell,
    full_name: u.full_name,
    builtin: u.builtin,
    smb: u.smb,
    userns_idmap: null,
    group: g
      ? {
          id: g.id,
          bsdgrp_gid: g.gid,
          bsdgrp_group: g.name,
          bsdgrp_builtin: g.builtin,
          bsdgrp_sudo_commands: g.sudo_commands,
          bsdgrp_sudo_commands_nopasswd: g.sudo_commands_nopasswd,
          bsdgrp_smb: g.smb,
        }
      : {},
    groups: u.groups,
    password_disabled: u.password_disabled,
    ssh_password_enabled: u.ssh_password_enabled,
    sshpubkey: u.sshpubkey,
    locked: u.locked,
    sudo_commands: u.sudo_commands,
    sudo_commands_nopasswd: u.sudo_commands_nopasswd,
    email: u.email,
    local: true,
    immutable: u.immutable,
    twofactor_auth_configured: false,
    sid: userSid(state, u),
    last_password_change: u.last_password_change ? $date(u.last_password_change) : null,
    password_age: u.last_password_change ? Math.floor((Date.now() - u.last_password_change) / 86400_000) : null,
    password_history: null,
    password_change_required: false,
    roles: userRoles(state, u),
    api_keys: state.apiKeys.filter((k) => k.username === u.username).map((k) => k.id),
  };
}

export function renderGroup(state: MockState, g: GroupState): Obj {
  return {
    id: g.id,
    gid: g.gid,
    name: g.name,
    builtin: g.builtin,
    sudo_commands: g.sudo_commands,
    sudo_commands_nopasswd: g.sudo_commands_nopasswd,
    smb: g.smb,
    userns_idmap: null,
    group: g.name,
    local: true,
    sid: groupSid(state, g),
    roles: g.roles,
    users: state.users.filter((u) => u.group === g.id || u.groups.includes(g.id)).map((u) => u.id),
    immutable: g.immutable,
  };
}

/** `user.get_user_obj` shape (also the base of `auth.me`). */
export function userObj(state: MockState, u: UserState, getGroups = true): Obj {
  return {
    pw_name: u.username,
    pw_gecos: u.full_name,
    pw_dir: u.home,
    pw_shell: u.shell,
    pw_uid: u.uid,
    pw_gid: groupById(state, u.group)?.gid ?? u.uid,
    grouplist: getGroups ? [u.group, ...u.groups].map((id) => groupById(state, id)?.gid ?? 0) : null,
    sid: userSid(state, u),
    source: 'LOCAL',
    local: true,
  };
}

export function findUserByName(state: MockState, username: string): UserState | undefined {
  return state.users.find((u) => u.username === username);
}

export function resolveUid(state: MockState, name: string): number | undefined {
  return findUserByName(state, name)?.uid;
}

export function resolveGid(state: MockState, name: string): number | undefined {
  return state.groups.find((g) => g.name === name)?.gid;
}

function nextFree(used: Set<number>, start: number): number {
  let n = start;
  while (used.has(n)) n++;
  return n;
}

function emitUser(mock: Mock, u: UserState, msg: 'added' | 'changed'): void {
  mock.emit('user.query', msg, u.id, renderUser(mock.state, u));
}

function emitGroup(mock: Mock, g: GroupState, msg: 'added' | 'changed'): void {
  mock.emit('group.query', msg, g.id, renderGroup(mock.state, g));
}

function validateHome(state: MockState, home: string, attr: string, errors: Array<[string, string]>, create: boolean): void {
  if (home === '/var/empty') return;
  const p = normPath(home);
  if (!p.startsWith('/mnt/')) {
    errors.push([attr, 'The home directory must be located under /mnt/']);
    return;
  }
  const ds = datasetContaining(state, p);
  if (!ds) errors.push([attr, 'The path for the home directory must be located on a ZFS dataset.']);
  else if (!pathKind(state, p)) errors.push([attr, 'Path does not exist.']);
  else if (ds.id === ds.pool && `/mnt/${ds.id}` === p && !create) {
    errors.push([attr, 'The pool root may not be used as a home directory unless home_create is set.']);
  }
}

export interface CreateUserInput {
  username: string;
  full_name: string;
  password?: string | null;
  smb?: boolean;
  group_create?: boolean;
  group?: number | null;
  groups?: number[];
  uid?: number | null;
  home?: string;
  home_create?: boolean;
  home_mode?: string;
  shell?: string;
  email?: string | null;
  password_disabled?: boolean;
  random_password?: boolean;
  locked?: boolean;
  sshpubkey?: string | null;
  ssh_password_enabled?: boolean;
  sudo_commands?: string[];
  sudo_commands_nopasswd?: string[];
}

/** `user.create` logic, also used by the "configured" scenario seed. */
export function createUser(mock: Mock, data: CreateUserInput, emit = true): { user: UserState; password: string | null } {
  const { state } = mock;
  const attr = 'user_create';
  const errors: Array<[string, string]> = [];
  const username = data.username;
  if (typeof username !== 'string' || !username) errors.push([`${attr}.username`, 'Field required']);
  else if (!USERNAME_RE.test(username) || username.length > 32) {
    errors.push([
      `${attr}.username`,
      'Valid characters are: letters, numbers, underscore, hyphen and period; the name may not begin with a hyphen or period and is limited to 32 characters.',
    ]);
  } else if (findUserByName(state, username)) errors.push([`${attr}.username`, `A user with the username "${username}" already exists.`]);
  if (typeof data.full_name !== 'string' || !data.full_name.trim()) errors.push([`${attr}.full_name`, 'Field required']);
  const smb = data.smb ?? true;
  const passwordDisabled = data.password_disabled ?? false;
  let password = data.password ?? null;
  if (data.random_password) password = randomString(20);
  if (!password && !passwordDisabled) errors.push([`${attr}.password`, 'Password is required.']);
  if (smb && passwordDisabled) errors.push([`${attr}.smb`, 'Password authentication may not be disabled for SMB users.']);
  if (data.email && !EMAIL_RE.test(data.email)) errors.push([`${attr}.email`, 'value is not a valid email address']);
  const groupCreate = data.group_create ?? false;
  if (!groupCreate && (data.group === undefined || data.group === null)) {
    errors.push([`${attr}.group`, 'Enter either a group name or create a new group to continue.']);
  } else if (!groupCreate && !groupById(state, data.group!)) errors.push([`${attr}.group`, `Group ${data.group} not found`]);
  if (groupCreate && username && state.groups.some((g) => g.name === username)) {
    errors.push([`${attr}.group_create`, `A group with the name "${username}" already exists. Disable group_create to use it as the primary group.`]);
  }
  for (const [i, gid] of (data.groups ?? []).entries()) {
    if (!groupById(state, gid)) errors.push([`${attr}.groups.${i}`, `Group ${gid} not found`]);
  }
  const usedUids = new Set(state.users.map((u) => u.uid));
  if (data.uid !== undefined && data.uid !== null && usedUids.has(data.uid)) errors.push([`${attr}.uid`, `Uid ${data.uid} is already used.`]);
  const home = data.home ?? '/var/empty';
  validateHome(state, home, `${attr}.home`, errors, data.home_create ?? false);
  if (errors.length) throw validationErrors(errors);

  const uid = data.uid ?? nextFree(usedUids, FIRST_UID);
  let groupId = data.group ?? 0;
  if (groupCreate) {
    const usedGids = new Set(state.groups.map((g) => g.gid));
    const group: GroupState = {
      id: state.nextIds.group++,
      gid: usedGids.has(uid) ? nextFree(usedGids, FIRST_UID) : uid,
      name: username,
      builtin: false,
      immutable: false,
      smb,
      sudo_commands: [],
      sudo_commands_nopasswd: [],
      roles: [],
    };
    state.groups.push(group);
    groupId = group.id;
    if (emit) emitGroup(mock, group, 'added');
  }
  let homePath = home;
  if (data.home_create && home !== '/var/empty') {
    homePath = `${normPath(home)}/${username}`;
    if (!state.fs.nodes.some((n) => n.path === homePath)) state.fs.nodes.push({ path: homePath, type: 'DIRECTORY', size: 2, mtime: Date.now() });
    const gid = groupById(state, groupId)?.gid ?? uid;
    state.fs.owners[homePath] = { uid, gid, mode: parseInt(data.home_mode ?? '700', 8) };
  }
  const user: UserState = {
    id: state.nextIds.user++,
    uid,
    username,
    full_name: data.full_name,
    email: data.email ?? null,
    home: homePath,
    shell: data.shell ?? '/usr/bin/zsh',
    smb,
    builtin: false,
    immutable: false,
    locked: data.locked ?? false,
    password_disabled: passwordDisabled,
    ssh_password_enabled: data.ssh_password_enabled ?? false,
    sshpubkey: data.sshpubkey ?? null,
    sudo_commands: data.sudo_commands ?? [],
    sudo_commands_nopasswd: data.sudo_commands_nopasswd ?? [],
    group: groupId,
    groups: data.groups ?? [],
    password,
    last_password_change: password ? Date.now() : null,
  };
  state.users.push(user);
  if (emit) {
    emitUser(mock, user, 'added');
    const g = groupById(state, groupId);
    if (g && !groupCreate) emitGroup(mock, g, 'changed');
  }
  return { user, password: data.random_password ? password : null };
}

function userArg(state: MockState, id: unknown): UserState {
  const u = state.users.find((x) => x.id === id);
  if (!u) throw callError('ENOENT', `User ${String(id)} does not exist`);
  return u;
}

export function registerAccounts(mock: Mock): void {
  const { server } = mock;

  server.method('user.query', (p) => queryFilter(mock.state.users.map((u) => renderUser(mock.state, u)), p[0], p[1]));
  server.method('user.get_instance', (p) => queryFilter(mock.state.users.map((u) => renderUser(mock.state, u)), [['id', '=', p[0]]], { get: true }));
  server.method('user.get_next_uid', () => nextFree(new Set(mock.state.users.map((u) => u.uid)), FIRST_UID));
  server.method('user.shell_choices', () => ({
    '/usr/bin/bash': 'bash',
    '/usr/bin/rbash': 'rbash',
    '/usr/bin/dash': 'dash',
    '/usr/bin/sh': 'sh',
    '/usr/bin/zsh': 'zsh',
    '/usr/bin/tmux': 'tmux',
    '/usr/sbin/nologin': 'nologin',
  }));
  server.method('user.has_local_administrator_set_up', () => mock.state.users.some((u) => !u.builtin && userRoles(mock.state, u).includes('FULL_ADMIN')));

  server.method('user.create', (p) => {
    const data = argObj(p[0], 'user_create') as unknown as CreateUserInput;
    const { user, password } = createUser(mock, data);
    return { ...renderUser(mock.state, user), password };
  });

  server.method('user.update', (p) => {
    const { state } = mock;
    const user = userArg(state, p[0]);
    const data = argObj(p[1], 'user_update');
    const attr = 'user_update';
    const errors: Array<[string, string]> = [];
    if ('uid' in data && data.uid !== user.uid) errors.push([`${attr}.uid`, 'Extra inputs are not permitted']);
    if ('group_create' in data) errors.push([`${attr}.group_create`, 'Extra inputs are not permitted']);
    if (user.immutable || user.builtin) {
      for (const key of ['username', 'group', 'home'] as const) {
        if (key in data && data[key] !== (key === 'group' ? user.group : user[key])) errors.push([`${attr}.${key}`, 'This attribute cannot be changed']);
      }
    }
    if (typeof data.username === 'string' && data.username !== user.username) {
      if (!USERNAME_RE.test(data.username) || data.username.length > 32) errors.push([`${attr}.username`, 'Invalid username.']);
      else if (findUserByName(state, data.username)) errors.push([`${attr}.username`, `A user with the username "${data.username}" already exists.`]);
    }
    if (data.smb === true && !user.smb && !data.password) {
      errors.push([`${attr}.smb`, 'A password is required when enabling SMB access for an existing user.']);
    }
    const smb = typeof data.smb === 'boolean' ? data.smb : user.smb;
    const pwDisabled = typeof data.password_disabled === 'boolean' ? data.password_disabled : user.password_disabled;
    if (smb && pwDisabled) errors.push([`${attr}.smb`, 'Password authentication may not be disabled for SMB users.']);
    if (typeof data.email === 'string' && data.email && !EMAIL_RE.test(data.email)) errors.push([`${attr}.email`, 'value is not a valid email address']);
    if (data.group !== undefined && !groupById(state, Number(data.group))) errors.push([`${attr}.group`, `Group ${String(data.group)} not found`]);
    if (typeof data.home === 'string' && data.home !== user.home) validateHome(state, data.home, `${attr}.home`, errors, data.home_create === true);
    if (errors.length) throw validationErrors(errors);

    const oldGroups = [user.group, ...user.groups];
    const str = (k: string) => (typeof data[k] === 'string' ? (data[k] as string) : undefined);
    if (str('username')) user.username = str('username')!;
    if (str('full_name') !== undefined) user.full_name = str('full_name')!;
    if ('email' in data) user.email = (data.email as string | null) || null;
    if (str('shell')) user.shell = str('shell')!;
    if (str('home')) user.home = data.home_create ? `${normPath(str('home')!)}/${user.username}` : normPath(str('home')!);
    if ('sshpubkey' in data) user.sshpubkey = (data.sshpubkey as string | null) ?? null;
    if (typeof data.smb === 'boolean') user.smb = data.smb;
    if (typeof data.locked === 'boolean') user.locked = data.locked;
    if (typeof data.password_disabled === 'boolean') user.password_disabled = data.password_disabled;
    if (typeof data.ssh_password_enabled === 'boolean') user.ssh_password_enabled = data.ssh_password_enabled;
    if (Array.isArray(data.sudo_commands)) user.sudo_commands = data.sudo_commands as string[];
    if (Array.isArray(data.sudo_commands_nopasswd)) user.sudo_commands_nopasswd = data.sudo_commands_nopasswd as string[];
    if (data.group !== undefined) user.group = Number(data.group);
    if (Array.isArray(data.groups)) user.groups = (data.groups as unknown[]).map(Number);
    if (typeof data.password === 'string' && data.password) {
      user.password = data.password;
      user.last_password_change = Date.now();
    }
    emitUser(mock, user, 'changed');
    for (const gid of new Set([...oldGroups, user.group, ...user.groups])) {
      const g = groupById(state, gid);
      if (g) emitGroup(mock, g, 'changed');
    }
    return { ...renderUser(state, user), password: null };
  });

  server.method('user.delete', (p) => {
    const { state } = mock;
    const user = userArg(state, p[0]);
    const opts = argObj(p[1], 'options');
    if (user.builtin || user.immutable) throw callError('EINVAL', 'Cannot delete a built-in user');
    const admins = state.users.filter((u) => !u.builtin && u.id !== user.id && userRoles(state, u).includes('FULL_ADMIN'));
    if (userRoles(state, user).includes('FULL_ADMIN') && !admins.length) {
      throw callError('EINVAL', 'Cannot delete the last local administrator account');
    }
    state.users = state.users.filter((u) => u.id !== user.id);
    state.apiKeys = state.apiKeys.filter((k) => k.username !== user.username);
    mock.emit('user.query', 'removed', user.id);
    const primary = groupById(state, user.group);
    const deleteGroup = opts.delete_group !== false;
    if (primary && !primary.builtin && deleteGroup && primary.name === user.username) {
      const stillUsed = state.users.some((u) => u.group === primary.id);
      if (!stillUsed) {
        state.groups = state.groups.filter((g) => g.id !== primary.id);
        mock.emit('group.query', 'removed', primary.id);
      }
    }
    return user.id;
  });

  server.method('user.get_user_obj', (p) => {
    const data = argObj(p[0], 'get_user_obj');
    const u =
      typeof data.username === 'string'
        ? findUserByName(mock.state, data.username)
        : typeof data.uid === 'number'
          ? mock.state.users.find((x) => x.uid === data.uid)
          : undefined;
    if (!u) throw callError('ENOENT', `${String(data.username ?? data.uid)}: user does not exist`);
    return userObj(mock.state, u, data.get_groups === true);
  });

  server.method('user.set_password', (p) => {
    const data = argObj(p[0], 'user_set_password');
    const u = findUserByName(mock.state, String(data.username));
    if (!u) throw callError('ENOENT', `${String(data.username)}: user does not exist`);
    if (u.password && data.old_password !== u.password) throw validationErrors([['user.set_password.old_password', 'The specified password is incorrect.']]);
    if (typeof data.new_password !== 'string' || !data.new_password) throw validationErrors([['user.set_password.new_password', 'Field required']]);
    u.password = data.new_password;
    u.last_password_change = Date.now();
    return null;
  });

  // Groups
  server.method('group.query', (p) => queryFilter(mock.state.groups.map((g) => renderGroup(mock.state, g)), p[0], p[1]));
  server.method('group.get_instance', (p) => queryFilter(mock.state.groups.map((g) => renderGroup(mock.state, g)), [['id', '=', p[0]]], { get: true }));
  server.method('group.get_next_gid', () => nextFree(new Set(mock.state.groups.map((g) => g.gid)), FIRST_UID));
  server.method('group.get_group_obj', (p) => {
    const data = argObj(p[0], 'get_group_obj');
    const g = mock.state.groups.find((x) => x.name === data.groupname || x.gid === data.gid);
    if (!g) throw callError('ENOENT', `${String(data.groupname ?? data.gid)}: group does not exist`);
    return { gr_name: g.name, gr_gid: g.gid, gr_mem: renderGroup(mock.state, g).users, sid: groupSid(mock.state, g), source: 'LOCAL', local: true };
  });
  server.method('group.create', (p) => {
    const { state } = mock;
    const data = argObj(p[0], 'group_create');
    const errors: Array<[string, string]> = [];
    const name = typeof data.name === 'string' ? data.name : '';
    if (!name) errors.push(['group_create.name', 'Field required']);
    else if (state.groups.some((g) => g.name === name)) errors.push(['group_create.name', `A Group with the name "${name}" already exists.`]);
    const usedGids = new Set(state.groups.map((g) => g.gid));
    if (typeof data.gid === 'number' && usedGids.has(data.gid) && data.allow_duplicate_gid !== true) {
      errors.push(['group_create.gid', `Gid ${data.gid} is already used.`]);
    }
    if (errors.length) throw validationErrors(errors);
    const g: GroupState = {
      id: state.nextIds.group++,
      gid: typeof data.gid === 'number' ? data.gid : nextFree(usedGids, FIRST_UID),
      name,
      builtin: false,
      immutable: false,
      smb: data.smb !== false,
      sudo_commands: Array.isArray(data.sudo_commands) ? (data.sudo_commands as string[]) : [],
      sudo_commands_nopasswd: Array.isArray(data.sudo_commands_nopasswd) ? (data.sudo_commands_nopasswd as string[]) : [],
      roles: [],
    };
    state.groups.push(g);
    if (Array.isArray(data.users)) {
      for (const uid of data.users) {
        const u = state.users.find((x) => x.id === uid);
        if (u && !u.groups.includes(g.id)) u.groups.push(g.id);
      }
    }
    emitGroup(mock, g, 'added');
    return g.id;
  });
  server.method('group.update', (p) => {
    const { state } = mock;
    const g = state.groups.find((x) => x.id === p[0]);
    if (!g) throw callError('ENOENT', `Group ${String(p[0])} does not exist`);
    const data = argObj(p[1], 'group_update');
    if (g.immutable && typeof data.name === 'string' && data.name !== g.name) throw validationErrors([['group_update.name', 'This attribute cannot be changed']]);
    if (typeof data.name === 'string' && data.name !== g.name && state.groups.some((x) => x.name === data.name)) {
      throw validationErrors([['group_update.name', `A Group with the name "${data.name}" already exists.`]]);
    }
    if (typeof data.name === 'string') g.name = data.name;
    if (typeof data.smb === 'boolean') g.smb = data.smb;
    if (Array.isArray(data.users)) {
      const members = new Set((data.users as unknown[]).map(Number));
      for (const u of state.users) {
        if (members.has(u.id) && !u.groups.includes(g.id) && u.group !== g.id) u.groups.push(g.id);
        if (!members.has(u.id)) u.groups = u.groups.filter((x) => x !== g.id);
      }
    }
    emitGroup(mock, g, 'changed');
    return g.id;
  });
  server.method('group.delete', (p) => {
    const { state } = mock;
    const g = state.groups.find((x) => x.id === p[0]);
    if (!g) throw callError('ENOENT', `Group ${String(p[0])} does not exist`);
    if (g.builtin || g.immutable) throw callError('EINVAL', 'A built-in group cannot be deleted.');
    const opts = isObj(p[1]) ? p[1] : {};
    const primaryUsers = state.users.filter((u) => u.group === g.id);
    if (primaryUsers.length && opts.delete_users !== true) {
      throw callError('EINVAL', `Group ${g.name} is the primary group of: ${primaryUsers.map((u) => u.username).join(', ')}`);
    }
    for (const u of primaryUsers) {
      state.users = state.users.filter((x) => x.id !== u.id);
      mock.emit('user.query', 'removed', u.id);
    }
    for (const u of state.users) u.groups = u.groups.filter((x) => x !== g.id);
    state.groups = state.groups.filter((x) => x.id !== g.id);
    mock.emit('group.query', 'removed', g.id);
    return g.id;
  });
}
