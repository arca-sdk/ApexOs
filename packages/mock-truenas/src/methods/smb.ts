import type { Mock } from '../context.ts';
import { callError, queryFilter, validationError, validationErrors } from '../rpc.ts';
import type { SmbShareAce, SmbShareState } from '../state.ts';
import { normPath, pathKind } from '../storage.ts';
import { argObj, isObj, uuid, type Obj } from '../util.ts';
import { groupSid, userSid } from './accounts.ts';

const PURPOSES: Record<string, { verbose: string; options: Obj; aapl?: boolean }> = {
  DEFAULT_SHARE: { verbose: 'Default share parameters', options: { aapl_name_mangling: false, hostsallow: [], hostsdeny: [] } },
  LEGACY_SHARE: {
    verbose: 'Legacy share',
    options: {
      recyclebin: false,
      path_suffix: null,
      hostsallow: [],
      hostsdeny: [],
      guestok: false,
      streams: true,
      durablehandle: true,
      shadowcopy: true,
      fsrvp: false,
      home: false,
      acl: true,
      afp: false,
      timemachine: false,
      timemachine_quota: 0,
      aapl_name_mangling: false,
      vuid: null,
      auxsmbconf: '',
    },
  },
  TIMEMACHINE_SHARE: {
    verbose: 'Multi-user time machine',
    options: { timemachine_quota: 0, auto_snapshot: false, auto_dataset_creation: false, dataset_naming_schema: null, vuid: null, hostsallow: [], hostsdeny: [] },
    aapl: true,
  },
  MULTIPROTOCOL_SHARE: { verbose: 'Multi-protocol (NFSv4/SMB) shares', options: { aapl_name_mangling: false, hostsallow: [], hostsdeny: [] } },
  TIME_LOCKED_SHARE: { verbose: 'Files become read-only after a grace period', options: { grace_period: 900, aapl_name_mangling: false, hostsallow: [], hostsdeny: [] } },
  PRIVATE_DATASETS_SHARE: {
    verbose: 'Private SMB Datasets and Shares',
    options: { dataset_naming_schema: null, auto_quota: 0, aapl_name_mangling: false, hostsallow: [], hostsdeny: [] },
  },
  EXTERNAL_SHARE: { verbose: 'Redirect to an external share (DFS)', options: { remote_path: [] } },
  VEEAM_REPOSITORY_SHARE: { verbose: 'Veeam Backup repository share', options: { hostsallow: [], hostsdeny: [] } },
  FCP_SHARE: { verbose: 'Final Cut Pro storage share', options: { aapl_name_mangling: true, hostsallow: [], hostsdeny: [] }, aapl: true },
};
const INVALID_NAME_CHARS = '%<>*?|/\\+=;:",[]';
const RESERVED_NAMES = ['global', 'printers', 'homes'];
const NETBIOS_RE = /^(?![0-9]*$)[a-zA-Z0-9.\-_!@#$%^&()'{}~]{1,15}$/;
export const EVERYONE_ACE: SmbShareAce = { ae_perm: 'FULL', ae_type: 'ALLOWED', ae_who_sid: 'S-1-1-0', ae_who_id: null };

export function renderShare(s: SmbShareState): Obj {
  return {
    id: s.id,
    purpose: s.purpose,
    name: s.name,
    path: s.path,
    enabled: s.enabled,
    comment: s.comment,
    readonly: s.readonly,
    browsable: s.browsable,
    access_based_share_enumeration: s.access_based_share_enumeration,
    locked: false,
    audit: s.audit,
    options: s.options,
  };
}

function validateShare(mock: Mock, data: Obj, attr: string, current?: SmbShareState): { purpose: string; options: Obj } {
  const { state } = mock;
  const errors: Array<[string, string]> = [];
  const name = (data.name ?? current?.name) as unknown;
  if (typeof name !== 'string' || !name) errors.push([`${attr}.name`, 'Field required']);
  else {
    const bad = [...new Set([...name].filter((c) => INVALID_NAME_CHARS.includes(c)))];
    if (bad.length) errors.push([`${attr}.name`, `Share name contains the following invalid characters: ${bad.join(', ')}`]);
    else if (RESERVED_NAMES.includes(name.toLowerCase())) errors.push([`${attr}.name`, `${name} is a reserved section name, please select another one`]);
    else if (name.length > 80) errors.push([`${attr}.name`, 'Share name may not exceed 80 characters']);
    else if (state.shares.some((s) => s !== current && s.name.toLowerCase() === name.toLowerCase())) {
      errors.push([`${attr}.name`, 'Share with this name already exists.']);
    }
  }
  if ('options' in data && !('purpose' in data) && !current) errors.push([`${attr}.purpose`, 'purpose is required when options are specified']);
  const purpose = String(data.purpose ?? current?.purpose ?? 'DEFAULT_SHARE');
  const def = PURPOSES[purpose];
  let options: Obj = {};
  if (!def) errors.push([`${attr}.purpose`, `Input should be ${Object.keys(PURPOSES).map((p) => `'${p}'`).join(', ')}`]);
  else {
    const base = current && current.purpose === purpose ? current.options : def.options;
    const given = data.options === undefined ? {} : data.options;
    if (!isObj(given)) errors.push([`${attr}.options`, 'Input should be a valid dictionary']);
    else {
      for (const key of Object.keys(given)) {
        if (!(key in def.options)) errors.push([`${attr}.options.${key}`, 'Extra inputs are not permitted']);
      }
      options = { ...structuredClone(def.options), ...structuredClone(base), ...structuredClone(given) };
      for (const key of ['hostsallow', 'hostsdeny']) {
        if (key in options && (!Array.isArray(options[key]) || (options[key] as unknown[]).some((x) => typeof x !== 'string'))) {
          errors.push([`${attr}.options.${key}`, 'Input should be a valid list of strings']);
        }
      }
      if (purpose === 'TIME_LOCKED_SHARE') {
        const g = options.grace_period;
        if (typeof g !== 'number' || g < 60 || g > 15552000) errors.push([`${attr}.options.grace_period`, 'Input should be between 60 and 15552000']);
      }
      if ((def.aapl || (purpose === 'LEGACY_SHARE' && options.timemachine === true)) && state.smb.aapl_extensions !== true) {
        errors.push([`${attr}.purpose`, 'Apple SMB2/3 protocol extension support is required by this parameter. This feature may be enabled in the general SMB server configuration.']);
      }
      if ('vuid' in options && !options.vuid && (purpose === 'TIMEMACHINE_SHARE' || options.timemachine === true)) options.vuid = uuid();
    }
  }
  const path = (data.path ?? current?.path) as unknown;
  if (purpose === 'EXTERNAL_SHARE') {
    if (path !== 'EXTERNAL') errors.push([`${attr}.path`, 'External shares must use the path "EXTERNAL"']);
  } else if (typeof path !== 'string' || !path) errors.push([`${attr}.path`, 'Field required']);
  else {
    const p = normPath(path);
    const pool = p.split('/')[2];
    if (!p.startsWith('/mnt/') || !pool || pool === '.ix-apps' || !state.pools.some((x) => x.name === pool)) {
      errors.push([`${attr}.path`, 'Path must reside within a pool mount point']);
    } else if (pathKind(state, p) !== 'DIRECTORY') errors.push([`${attr}.path`, 'Path does not exist.']);
  }
  if (errors.length) throw validationErrors(errors);
  return { purpose, options };
}

/** Validates share ACL input like the middleware: principals by SID, or by Unix id of an SMB account. */
function aclEntries(mock: Mock, raw: unknown, attr: string): SmbShareAce[] {
  if (!Array.isArray(raw)) throw validationError(attr, 'Input should be a valid list');
  const { state } = mock;
  const errors: Array<[string, string]> = [];
  const out: SmbShareAce[] = [];
  raw.forEach((e: unknown, i) => {
    const a = `${attr}.${i}`;
    if (!isObj(e)) return void errors.push([a, 'Input should be a valid dictionary']);
    if (!['FULL', 'CHANGE', 'READ'].includes(String(e.ae_perm))) errors.push([`${a}.ae_perm`, "Input should be 'FULL', 'CHANGE' or 'READ'"]);
    if (!['ALLOWED', 'DENIED'].includes(String(e.ae_type))) errors.push([`${a}.ae_type`, "Input should be 'ALLOWED' or 'DENIED'"]);
    let sid: string | null = null;
    if (typeof e.ae_who_sid === 'string' && e.ae_who_sid) {
      sid = e.ae_who_sid;
      if (!/^S-1-\d+(-\d+)+$/.test(sid)) errors.push([`${a}.ae_who_sid`, 'SID is malformed']);
      else if (sid.startsWith('S-1-22-1-') || sid.startsWith('S-1-22-2-')) {
        errors.push([`${a}.sid`, 'SID entries for SMB Share ACLs may not be specially-encoded Unix User IDs or Groups.']);
      }
    } else if (isObj(e.ae_who_id)) {
      const { id_type: type, id } = e.ae_who_id;
      if (type === 'USER') {
        const u = state.users.find((x) => x.uid === id);
        sid = u ? userSid(state, u) : null;
      } else if (type === 'GROUP' || type === 'BOTH') {
        const g = state.groups.find((x) => x.gid === id);
        sid = g ? groupSid(state, g) : null;
      } else return void errors.push([`${a}.ae_who_id.id_type`, "Input should be 'USER' or 'GROUP'"]);
      if (!sid) return void errors.push([`${a}.ae_who_id`, 'User or group does must exist and be an SMB account.']);
    } else if (typeof e.ae_who_str === 'string' && /^everyone@?$/i.test(e.ae_who_str)) {
      sid = 'S-1-1-0';
    } else {
      return void errors.push([`${a}.sid`, 'Either a SID or Unix ID must be specified for ACL entry.']);
    }
    out.push({ ae_perm: e.ae_perm as SmbShareAce['ae_perm'], ae_type: e.ae_type as SmbShareAce['ae_type'], ae_who_sid: sid, ae_who_id: null });
  });
  if (errors.length) throw validationErrors(errors);
  return out;
}

/** Well-known BUILTIN SIDs that winbind maps onto the local builtin groups. */
const BUILTIN_ALIASES: Record<string, number> = { 'S-1-5-32-544': 544, 'S-1-5-32-545': 545, 'S-1-5-32-546': 546 };

/** `sharing.smb.getacl` entries: SIDs mapped back to Unix ids and names (`ae_who_str`). */
function renderShareAcl(mock: Mock, share: SmbShareState): Obj {
  const { state } = mock;
  const share_acl = share.share_acl.map((ace) => {
    const base = { ae_who_sid: ace.ae_who_sid, ae_perm: ace.ae_perm, ae_type: ace.ae_type };
    if (ace.ae_who_sid === 'S-1-1-0') return { ...base, ae_who_id: null, ae_who_str: 'everyone@' };
    const u = state.users.find((x) => userSid(state, x) === ace.ae_who_sid);
    if (u) return { ...base, ae_who_id: { id_type: 'USER', id: u.uid }, ae_who_str: u.username };
    const alias = ace.ae_who_sid ? BUILTIN_ALIASES[ace.ae_who_sid] : undefined;
    const g = state.groups.find((x) => (alias !== undefined ? x.gid === alias : groupSid(state, x) === ace.ae_who_sid));
    if (g) return { ...base, ae_who_id: { id_type: 'GROUP', id: g.gid }, ae_who_str: g.name };
    return { ...base, ae_who_id: null, ae_who_str: null };
  });
  return { share_name: share.name, share_acl };
}

export function createShare(mock: Mock, data: Obj, emit = true): SmbShareState {
  const { purpose, options } = validateShare(mock, data, 'sharingsmb_create');
  const share: SmbShareState = {
    id: mock.state.nextIds.share++,
    purpose,
    name: String(data.name),
    path: purpose === 'EXTERNAL_SHARE' ? 'EXTERNAL' : normPath(String(data.path)),
    enabled: data.enabled !== false,
    comment: typeof data.comment === 'string' ? data.comment : '',
    readonly: data.readonly === true,
    browsable: data.browsable !== false,
    access_based_share_enumeration: data.access_based_share_enumeration === true,
    audit: { enable: false, watch_list: [], ignore_list: [], ...(isObj(data.audit) ? (data.audit as Obj) : {}) } as SmbShareState['audit'],
    options,
    share_acl: [EVERYONE_ACE],
  };
  mock.state.shares.push(share);
  if (emit) mock.emit('sharing.smb.query', 'added', share.id, renderShare(share));
  return share;
}

export function setShareAcl(mock: Mock, shareName: string, raw: unknown): Obj {
  const entries = aclEntries(mock, raw, 'sharing_smb_setacl.share_acl');
  const share = mock.state.shares.find((s) => s.name.toLowerCase() === shareName.toLowerCase());
  if (!share) throw validationError('smb_share_acl.share_name', 'Share does not exist');
  share.share_acl = entries.length ? entries : [EVERYONE_ACE];
  return renderShareAcl(mock, share);
}

function smbConfigValidate(mock: Mock, data: Obj): void {
  const errors: Array<[string, string]> = [];
  if ('netbiosname' in data && (typeof data.netbiosname !== 'string' || !NETBIOS_RE.test(data.netbiosname))) {
    errors.push(['smb_update.netbiosname', 'Invalid NetBIOS name. NetBIOS names must be 1-15 characters and may not consist only of numbers.']);
  }
  if ('workgroup' in data && (typeof data.workgroup !== 'string' || !NETBIOS_RE.test(data.workgroup))) errors.push(['smb_update.workgroup', 'Invalid workgroup name']);
  if ('netbiosalias' in data && (!Array.isArray(data.netbiosalias) || data.netbiosalias.some((a) => typeof a !== 'string' || !NETBIOS_RE.test(a)))) {
    errors.push(['smb_update.netbiosalias', 'Invalid NetBIOS alias']);
  }
  if ('encryption' in data && !['DEFAULT', 'NEGOTIATE', 'DESIRED', 'REQUIRED'].includes(String(data.encryption))) {
    errors.push(['smb_update.encryption', "Input should be 'DEFAULT', 'NEGOTIATE', 'DESIRED' or 'REQUIRED'"]);
  }
  if (data.aapl_extensions === false && mock.state.shares.some((s) => PURPOSES[s.purpose]?.aapl || s.options.timemachine === true)) {
    errors.push(['smb_update.aapl_extensions', 'Apple SMB2/3 protocol extensions are required by existing Time Machine or Final Cut Pro shares.']);
  }
  for (const key of Object.keys(data)) {
    if (key === 'id' || key === 'server_sid') errors.push([`smb_update.${key}`, 'Extra inputs are not permitted']);
  }
  if (errors.length) throw validationErrors(errors);
}

export function registerSmb(mock: Mock): void {
  const { server } = mock;
  const shares = () => mock.state.shares.map(renderShare);
  const shareArg = (id: unknown) => {
    const s = mock.state.shares.find((x) => x.id === id);
    if (!s) throw callError('ENOENT', `SMB share ${String(id)} does not exist`);
    return s;
  };

  server.method('sharing.smb.query', (p) => queryFilter(shares(), p[0], p[1]));
  server.method('sharing.smb.get_instance', (p) => queryFilter(shares(), [['id', '=', p[0]]], { get: true }));
  server.method('sharing.smb.create', (p) => renderShare(createShare(mock, argObj(p[0], 'sharingsmb_create'))));
  server.method('sharing.smb.update', (p) => {
    const share = shareArg(p[0]);
    const data = argObj(p[1], 'sharingsmb_update');
    const { purpose, options } = validateShare(mock, data, 'sharingsmb_update', share);
    if (typeof data.name === 'string') share.name = data.name;
    if (typeof data.path === 'string') share.path = normPath(data.path);
    share.purpose = purpose;
    share.options = options;
    for (const key of ['enabled', 'readonly', 'browsable', 'access_based_share_enumeration'] as const) {
      if (typeof data[key] === 'boolean') share[key] = data[key] as boolean;
    }
    if (typeof data.comment === 'string') share.comment = data.comment;
    if (isObj(data.audit)) share.audit = { ...share.audit, ...(data.audit as Partial<SmbShareState['audit']>) };
    const entry = renderShare(share);
    mock.emit('sharing.smb.query', 'changed', share.id, entry);
    return entry;
  });
  server.method('sharing.smb.delete', (p) => {
    const share = shareArg(p[0]);
    mock.state.shares = mock.state.shares.filter((s) => s !== share);
    mock.emit('sharing.smb.query', 'removed', share.id);
    return true;
  });
  server.method('sharing.smb.getacl', (p) => {
    const name = String(argObj(p[0], 'smb_getacl').share_name ?? '');
    const share = mock.state.shares.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (!share) throw validationError('sharing_smb_getacl.share_name', 'Share does not exist');
    return renderShareAcl(mock, share);
  });
  server.method('sharing.smb.setacl', (p) => {
    const data = argObj(p[0], 'smb_setacl');
    if (typeof data.share_name !== 'string') throw validationError('smb_setacl.share_name', 'Field required');
    return setShareAcl(mock, data.share_name, data.share_acl ?? []);
  });
  server.method('sharing.smb.presets', () =>
    Object.fromEntries(Object.entries(PURPOSES).map(([k, v]) => [k, { verbose_name: v.verbose, params: { purpose: k, options: v.options } }])),
  );
  server.method('sharing.smb.share_precheck', (p) => {
    const data = argObj(p[0], 'share_precheck');
    const errors: Array<[string, string]> = [];
    if (!mock.state.users.some((u) => u.smb && !u.builtin)) {
      errors.push([
        'sharing.smb.share_precheck',
        'TrueNAS server must be joined to a directory service or have at least one local SMB user before creating an SMB share.',
      ]);
    }
    if (typeof data.name === 'string' && mock.state.shares.some((s) => s.name.toLowerCase() === String(data.name).toLowerCase())) {
      errors.push(['sharing.smb.share_precheck.name', 'Share with this name already exists.']);
    }
    if (errors.length) throw validationErrors(errors);
    return null;
  });

  server.method('smb.config', () => mock.state.smb);
  server.method('smb.update', (p) => {
    const data = argObj(p[0], 'smb_update');
    smbConfigValidate(mock, data);
    Object.assign(mock.state.smb, data);
    return mock.state.smb;
  });
  server.method('smb.status', () => []);
  server.method('smb.bindip_choices', () => Object.fromEntries([[mock.lanIp, mock.lanIp]]));
}
