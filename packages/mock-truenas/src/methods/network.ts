import type { Mock } from '../context.ts';
import {
  assignedAddresses,
  broadcast,
  effectiveGateway,
  effectiveNameservers,
  gatewayReachable,
  inSubnet,
  isIpAddress,
  isIpv4,
  isPhysical,
  linkLocal,
  networkInt,
  networksOverlap,
  intToIpv4,
  primaryAddress,
  reachableFromLan,
  reportedDhcp,
  restoreSnapshot,
  syncNetwork,
  takeSnapshot,
} from '../network.ts';
import { callError, queryFilter, validationError, validationErrors } from '../rpc.ts';
import type { InterfaceState } from '../state.ts';
import { argObj, isObj, notFound, type Obj } from '../util.ts';

const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

export function renderInterface(mock: Mock, i: InterfaceState): Obj {
  const n = mock.state.network;
  const vlan = i.type === 'VLAN' && i.vlan ? i.vlan : null;
  const fake = i.live === false;
  const inet = i.addresses.map((a) => ({ type: 'INET', address: a.address, netmask: a.netmask, broadcast: broadcast(a.address, a.netmask) }));
  const live = fake
    ? []
    : [
        ...inet,
        ...(i.linkUp ? [{ type: 'INET6', address: linkLocal(i.mac), netmask: 64, broadcast: null }] : []),
        { type: 'LINK', address: i.mac },
      ];
  const media = i.linkUp ? `${i.speed}Mb/s Twisted Pair` : '';
  return {
    id: i.name,
    name: i.name,
    fake,
    type: i.type ?? 'PHYSICAL',
    description: i.description,
    mtu: i.configured ? (i.configuredMtu ?? null) : null,
    ipv4_dhcp: reportedDhcp(n, i),
    ipv6_auto: !n.interfaces.some((x) => x.configured),
    aliases: i.configured ? i.aliases : [],
    state: {
      name: i.name,
      orig_name: i.name,
      description: i.description,
      mtu: fake ? 1500 : i.mtu,
      cloned: !isPhysical(i),
      flags: fake ? [] : i.linkUp ? ['UP', 'BROADCAST', 'RUNNING', 'MULTICAST', 'LOWER_UP'] : ['UP', 'BROADCAST', 'MULTICAST'],
      nd6_flags: [],
      capabilities: fake ? [] : ['RXCSUM', 'TXCSUM', 'TSO4', 'TSO6'],
      link_state: fake ? '' : i.linkUp ? 'LINK_STATE_UP' : 'LINK_STATE_DOWN',
      media_type: fake ? '' : 'Ethernet',
      media_subtype: fake ? '' : media || 'autoselect',
      active_media_type: fake ? '' : 'Ethernet',
      active_media_subtype: fake ? '' : media,
      supported_media: fake || vlan ? [] : ['10baseT/Half', '10baseT/Full', '100baseT/Half', '100baseT/Full', '1000baseT/Full'],
      media_options: fake ? [] : null,
      link_address: fake ? '' : i.mac,
      permanent_link_address: fake ? null : i.mac,
      hardware_link_address: fake ? '' : i.mac,
      ...(fake ? {} : { rx_queues: 4, tx_queues: 4 }),
      aliases: live,
      vrrp_config: [],
      ...(vlan && !fake ? { parent: vlan.parent, tag: vlan.tag, pcp: vlan.pcp } : {}),
    },
    ...(vlan ? { vlan_parent_interface: vlan.parent, vlan_tag: vlan.tag, vlan_pcp: vlan.pcp } : {}),
    lag_ports: [],
    bridge_members: [],
  };
}

function networkConfig(mock: Mock): Obj {
  const n = mock.state.network;
  const dns = effectiveNameservers(n);
  return {
    id: 1,
    hostname: n.hostname,
    domain: n.domain,
    ipv4gateway: n.ipv4gateway,
    ipv6gateway: '',
    nameserver1: n.nameservers[0],
    nameserver2: n.nameservers[1],
    nameserver3: n.nameservers[2],
    httpproxy: '',
    hosts: [],
    domains: [],
    service_announcement: { netbios: false, mdns: true, wsd: true },
    activity: { type: 'DENY', activities: [] },
    hostname_local: n.hostname,
    state: {
      ipv4gateway: effectiveGateway(n) ?? '',
      ipv6gateway: '',
      nameserver1: dns[0] ?? '',
      nameserver2: dns[1] ?? '',
      nameserver3: dns[2] ?? '',
      hosts: [],
    },
  };
}

// ---------------------------------------------------------------------------
// Argument validation (pydantic models of interface.create / interface.update)
// ---------------------------------------------------------------------------

const CREATE_FIELDS = new Set([
  'name', 'description', 'type', 'ipv4_dhcp', 'ipv6_auto', 'aliases', 'failover_critical', 'failover_group', 'failover_vhid',
  'failover_aliases', 'failover_virtual_aliases', 'bridge_members', 'enable_learning', 'stp', 'lag_protocol', 'xmit_hash_policy',
  'lacpdu_rate', 'lag_ports', 'vlan_parent_interface', 'vlan_tag', 'vlan_pcp', 'mtu',
]);

type Alias = InterfaceState['aliases'][number];

function checkFields(data: Obj, schema: string, update: boolean): void {
  const errors: Array<[string, string]> = [];
  for (const key of Object.keys(data)) {
    if (!CREATE_FIELDS.has(key) || (update && key === 'type')) errors.push([`${schema}.${key}`, 'Extra inputs are not permitted']);
  }
  for (const key of ['ipv4_dhcp', 'ipv6_auto']) {
    if (key in data && typeof data[key] !== 'boolean') errors.push([`${schema}.${key}`, 'Input should be a valid boolean']);
  }
  for (const key of ['description', 'name', 'vlan_parent_interface']) {
    if (key in data && typeof data[key] !== 'string') errors.push([`${schema}.${key}`, 'Input should be a valid string']);
  }
  const intRange = (key: string, min: number, max: number, nullable: boolean) => {
    if (!(key in data)) return;
    const v = data[key];
    if (v === null && nullable) return;
    if (typeof v !== 'number' || !Number.isInteger(v)) errors.push([`${schema}.${key}`, 'Input should be a valid integer']);
    else if (v < min) errors.push([`${schema}.${key}`, `Input should be greater than or equal to ${min}`]);
    else if (v > max) errors.push([`${schema}.${key}`, `Input should be less than or equal to ${max}`]);
  };
  intRange('vlan_tag', 1, 4094, false);
  intRange('vlan_pcp', 0, 7, true);
  intRange('mtu', 68, 9216, true);
  if (errors.length) throw validationErrors(errors);
}

function parseAliases(value: unknown, schema: string): Alias[] {
  if (!Array.isArray(value)) throw validationError(`${schema}.aliases`, 'Input should be a valid list');
  const errors: Array<[string, string]> = [];
  const aliases = value.map((raw, idx): Alias => {
    const at = `${schema}.aliases.${idx}`;
    if (!isObj(raw)) {
      errors.push([at, 'Input should be a valid dictionary']);
      return { type: 'INET', address: '', netmask: 0 };
    }
    const type = raw.type ?? 'INET';
    if (type !== 'INET' && type !== 'INET6') errors.push([`${at}.type`, "Input should be 'INET' or 'INET6'"]);
    if (!isIpAddress(raw.address)) errors.push([`${at}.address`, 'Input is not a valid IPv4 or IPv6 address']);
    const max = type === 'INET6' ? 128 : 32;
    if (typeof raw.netmask !== 'number' || !Number.isInteger(raw.netmask)) errors.push([`${at}.netmask`, 'Input should be a valid integer']);
    else if (raw.netmask < 0 || raw.netmask > max) errors.push([`${at}.netmask`, `Invalid netmask for ${String(raw.address)}`]);
    return { type: type as Alias['type'], address: String(raw.address), netmask: Number(raw.netmask) };
  });
  const seen = new Set<string>();
  aliases.forEach((a, idx) => {
    const key = `${a.address}/${a.netmask}`;
    if (seen.has(key)) errors.push([`${schema}.aliases.${idx}`, 'List items must be unique']);
    seen.add(key);
  });
  if (errors.length) throw validationErrors(errors);
  return aliases;
}

export function registerNetwork(mock: Mock): void {
  const { server } = mock;
  const net = () => mock.state.network;
  const ifaces = () => net().interfaces.map((i) => renderInterface(mock, i));
  const find = (name: unknown): InterfaceState => {
    const found = net().interfaces.find((i) => i.name === name);
    if (!found) throw notFound(`Interface ${String(name)} does not exist`);
    return found;
  };

  const saveSnapshot = () => {
    mock.network.snapshot ??= takeSnapshot(net());
  };

  const emitAll = () => {
    for (const i of net().interfaces) mock.emit('interface.query', 'changed', i.name, renderInterface(mock, i));
  };

  /** Clients are cut off when the address they used disappears, or for good when no LAN address is left. */
  const applyConnectivity = (addressBefore: string, cut: boolean) => {
    const n = net();
    if (cut || !reachableFromLan(n)) {
      server.setReachable(false);
      return;
    }
    const wasUnreachable = !server.reachable;
    server.setReachable(true);
    if (!wasUnreachable && !assignedAddresses(n).has(addressBefore)) server.dropConnections();
  };

  const clearTimer = () => {
    clearTimeout(mock.network.rollbackTimer);
    mock.network.rollbackTimer = undefined;
    mock.network.rollbackAt = 0;
  };

  const rollback = () => {
    clearTimer();
    const before = primaryAddress(net());
    if (mock.network.snapshot) restoreSnapshot(net(), mock.network.snapshot);
    mock.network.snapshot = null;
    syncNetwork(net());
    applyConnectivity(before, false);
    emitAll();
  };

  /** `network.common.check_dhcp_or_aliases`. */
  const assertSomethingConfigured = (schema: string) => {
    const any = ifaces().some((i) => i.ipv4_dhcp || i.ipv6_auto || (i.aliases as unknown[]).length);
    if (!any) throw validationError(schema, 'At least one interface must be configured with IPv4 DHCP, IPv6 Autoconfig or a static IP.');
  };

  /** `_common_validation` for the fields the simulator models. */
  const commonValidation = (schema: string, data: Obj, type: 'PHYSICAL' | 'VLAN', self: InterfaceState | null) => {
    const n = net();
    const others = n.interfaces.filter((i) => i !== self);
    const errors: Array<[string, string]> = [];
    if (!self && typeof data.name === 'string' && n.interfaces.some((i) => i.name === data.name)) {
      errors.push([`${schema}.name`, 'Interface name is already in use.']);
    }
    if (data.ipv4_dhcp === true && others.some((i) => i.configured && i.ipv4_dhcp && i.live !== false)) {
      errors.push([`${schema}.ipv4_dhcp`, 'Only one interface can be used for DHCP.']);
    }
    const aliases = (data.aliases as Alias[] | undefined) ?? [];
    aliases.forEach((a, idx) => {
      if (a.type !== 'INET') return;
      const clash = others.some((o) =>
        (o.configured ? o.aliases : []).some((u) => u.type === 'INET' && networksOverlap(u.address, u.netmask, a.address, a.netmask)),
      );
      if (clash) {
        errors.push([`${schema}.aliases.${idx}`, `The network ${intToIpv4(networkInt(a.address, a.netmask))}/${a.netmask} is already in use by another interface.`]);
      }
    });
    if (type === 'VLAN') {
      if (typeof data.name === 'string' && !/^vlan\d+$/.test(data.name)) {
        errors.push([`${schema}.name`, 'VLAN interface must start with "vlan" followed by an unique number.']);
      }
      const parent = others.find((i) => i.name === data.vlan_parent_interface);
      if (!parent) errors.push([`${schema}.vlan_parent_interface`, 'Not a valid interface.']);
      else if (parent.name.startsWith('br')) errors.push([`${schema}.vlan_parent_interface`, 'Bridge interfaces are not allowed.']);
      else if (typeof data.mtu === 'number' && data.mtu > (parent.configuredMtu ?? 1500)) {
        errors.push([`${schema}.mtu`, 'VLAN MTU cannot be bigger than parent interface.']);
      }
    }
    if (errors.length) throw validationErrors(errors);
  };

  server.method('interface.query', (p) => queryFilter(ifaces(), p[0], p[1]));
  server.method('interface.get_instance', (p) => queryFilter(ifaces(), [['id', '=', p[0]]], { get: true }));
  server.method('interface.websocket_local_ip', () => mock.lanIp);
  server.method('interface.websocket_interface', () => {
    const ip = mock.lanIp;
    return ifaces().find((i) => [...(i.aliases as Obj[]), ...((i.state as Obj).aliases as Obj[])].some((a) => a.address === ip)) ?? null;
  });
  server.method('interface.vlan_parent_interface_choices', () =>
    Object.fromEntries(net().interfaces.filter(isPhysical).map((i) => [i.name, i.description ? `${i.name}: ${i.description}` : i.name])),
  );
  server.method('interface.ip_in_use', (p) => {
    const opts = argObj(p[0], 'options');
    const out: Obj[] = [];
    for (const i of net().interfaces) {
      if (i.live === false) continue;
      if (Array.isArray(opts.interfaces) && opts.interfaces.length && !opts.interfaces.includes(i.name)) continue;
      for (const a of i.addresses) {
        if (opts.static === true && !i.aliases.some((x) => x.address === a.address)) continue;
        out.push({ type: 'INET', address: a.address, netmask: a.netmask, broadcast: broadcast(a.address, a.netmask) });
      }
    }
    return out;
  });
  server.method('route.ipv4gw_reachable', (p) => {
    if (!isIpv4(p[0])) throw validationError('ipv4_gateway', 'Input is not a valid IPv4 address');
    return gatewayReachable(net(), p[0]);
  });

  // ---- staging ----
  server.method('interface.create', (p) => {
    const data = { ...argObj(p[0], 'interface_create') };
    checkFields(data, 'interface_create', false);
    if (data.type === undefined) throw validationError('interface_create.type', 'Field required');
    if (!['BRIDGE', 'LINK_AGGREGATION', 'VLAN'].includes(String(data.type))) {
      throw validationError('interface_create.type', "Input should be 'BRIDGE', 'LINK_AGGREGATION' or 'VLAN'");
    }
    if (data.type !== 'VLAN') throw callError('ENOTSUP', 'The simulator only models VLAN interfaces');
    const missing = ['vlan_parent_interface', 'vlan_tag'].filter((k) => !(k in data));
    if (missing.length) throw validationErrors(missing.map((k) => [`interface_create.${k}`, 'This field is required']));
    data.aliases = parseAliases(data.aliases ?? [], 'interface_create');
    commonValidation('interface_create', data, 'VLAN', null);
    saveSnapshot();
    const n = net();
    let name = typeof data.name === 'string' ? data.name : undefined;
    if (!name) {
      let k = 0;
      while (n.interfaces.some((i) => i.name === `vlan${k}`)) k++;
      name = `vlan${k}`;
    }
    const iface: InterfaceState = {
      name,
      type: 'VLAN',
      mac: '',
      linkUp: false,
      speed: null,
      configured: true,
      ipv4_dhcp: data.ipv4_dhcp === true,
      addresses: [],
      aliases: data.aliases as Alias[],
      description: typeof data.description === 'string' ? data.description : '',
      mtu: 1500,
      configuredMtu: typeof data.mtu === 'number' ? data.mtu : null,
      vlan: { parent: String(data.vlan_parent_interface), tag: Number(data.vlan_tag), pcp: typeof data.vlan_pcp === 'number' ? data.vlan_pcp : null },
      live: false,
    };
    n.interfaces.push(iface);
    const rendered = renderInterface(mock, iface);
    mock.emit('interface.query', 'added', name, rendered);
    return rendered;
  });

  server.method('interface.update', (p) => {
    const iface = find(p[0]);
    const data = { ...argObj(p[1], 'interface_update') };
    checkFields(data, 'interface_update', true);
    if ('aliases' in data) data.aliases = parseAliases(data.aliases, 'interface_update');
    if ('name' in data && data.name !== iface.name) throw callError('ENOTSUP', 'The simulator does not model renaming interfaces');
    const current = renderInterface(mock, iface);
    const merged: Obj = { ...current, ...data };
    commonValidation('interface_update', merged, iface.type ?? 'PHYSICAL', iface);
    saveSnapshot();
    iface.configured = true;
    iface.ipv4_dhcp = merged.ipv4_dhcp === true;
    iface.aliases = merged.aliases as Alias[];
    if (typeof data.description === 'string') iface.description = data.description;
    if ('mtu' in data) iface.configuredMtu = (data.mtu as number | null) ?? null;
    if (iface.type === 'VLAN' && iface.vlan) {
      iface.vlan = {
        parent: String(merged.vlan_parent_interface),
        tag: Number(merged.vlan_tag),
        pcp: typeof merged.vlan_pcp === 'number' ? merged.vlan_pcp : null,
      };
    }
    const rendered = renderInterface(mock, iface);
    mock.emit('interface.query', 'changed', iface.name, rendered);
    return rendered;
  });

  server.method('interface.delete', (p) => {
    const iface = find(p[0]);
    const n = net();
    const dependents = n.interfaces.filter((i) => i.type === 'VLAN' && i.vlan?.parent === iface.name).map((i) => i.name);
    if (dependents.length) throw validationError('interface.delete', `The following VLANs depend on this interface: ${dependents.join(', ')}`);
    saveSnapshot();
    if (iface.type === 'VLAN') {
      // Cloned interfaces without a database row are hidden from interface.query right away.
      n.interfaces = n.interfaces.filter((i) => i !== iface);
    } else {
      Object.assign(iface, { configured: false, ipv4_dhcp: false, aliases: [], description: '', configuredMtu: null });
    }
    mock.emit('interface.query', 'removed', iface.name);
    return iface.name;
  });

  // ---- applying, confirming, undoing ----
  server.method('interface.has_pending_changes', () => mock.network.snapshot !== null);

  server.method('interface.commit', (p) => {
    const opts = argObj(p[0], 'options');
    const rollbackEnabled = opts.rollback === undefined ? true : opts.rollback;
    const timeout = opts.checkin_timeout === undefined ? 60 : opts.checkin_timeout;
    if (typeof rollbackEnabled !== 'boolean') throw validationError('options.rollback', 'Input should be a valid boolean');
    if (typeof timeout !== 'number' || !Number.isInteger(timeout)) throw validationError('options.checkin_timeout', 'Input should be a valid integer');
    assertSomethingConfigured('interface.commit');

    const n = net();
    const before = primaryAddress(n);
    syncNetwork(n);
    clearTimer();
    if (rollbackEnabled && timeout > 0) {
      mock.network.rollbackAt = Date.now() + timeout * 1000;
      mock.network.rollbackTimer = setTimeout(rollback, timeout * 1000);
      mock.network.rollbackTimer.unref();
    } else {
      mock.network.snapshot = null;
    }
    const cut = mock.network.cutNextCommit;
    mock.network.cutNextCommit = false;
    emitAll();
    // A real commit reconfigures the interfaces while the call is in flight: if the client's address
    // goes away, the reply never arrives.
    applyConnectivity(before, cut);
    return null;
  });

  server.method('interface.checkin', () => {
    clearTimer();
    mock.network.snapshot = null;
    return null;
  });

  server.method('interface.cancel_rollback', () => {
    clearTimer();
    return null;
  });

  server.method('interface.checkin_waiting', () => {
    if (!mock.network.rollbackTimer) return null;
    const remaining = (mock.network.rollbackAt - Date.now()) / 1000;
    return remaining > 0 ? Math.floor(remaining) : null;
  });

  server.method('interface.rollback', () => {
    rollback();
    return null;
  });

  server.method('interface.save_network_config', (p) => {
    const data = argObj(p[0], 'config');
    const errors: Array<[string, string]> = [];
    if (!isIpv4(data.ipv4gateway)) errors.push(['config.ipv4gateway', 'Input is not a valid IPv4 address']);
    for (const key of ['nameserver1', 'nameserver2', 'nameserver3']) {
      if (key in data && !isIpAddress(data[key])) errors.push([`config.${key}`, 'Input is not a valid IPv4 or IPv6 address']);
    }
    if (errors.length) throw validationErrors(errors);
    if (!mock.network.snapshot) throw callError('EFAULT', 'There are no pending interface changes.');
    const n = net();
    const gw = String(data.ipv4gateway);
    const reachable = n.interfaces.some((i) => i.configured && i.aliases.some((a) => a.type === 'INET' && inSubnet(gw, a.address, a.netmask)));
    if (!reachable) throw callError('EFAULT', `'${gw}' is not reachable from any interface on the system.`);
    n.ipv4gateway = gw;
    (['nameserver1', 'nameserver2', 'nameserver3'] as const).forEach((k, idx) => {
      if (typeof data[k] === 'string') n.nameservers[idx] = data[k] as string;
    });
    return null;
  });

  // ---- global configuration ----
  server.method('network.configuration.config', () => networkConfig(mock));
  server.method('network.configuration.update', (p) => {
    const data = argObj(p[0], 'global_configuration_update');
    const n = mock.state.network;
    const schema = 'global_configuration_update';
    const errors: Array<[string, string]> = [];
    if ('hostname' in data && (typeof data.hostname !== 'string' || !HOSTNAME_RE.test(data.hostname))) {
      errors.push([`${schema}.hostname`, 'Invalid hostname: use letters, numbers and hyphens (max 63 characters).']);
    }
    const provided: number[] = [];
    (['nameserver1', 'nameserver2', 'nameserver3'] as const).forEach((key, idx) => {
      const v = data[key];
      if (v === undefined || v === '') return;
      provided.push(idx + 1);
      if (!isIpAddress(v)) errors.push([`${schema}.${key}`, `'${String(v)}' does not appear to be an IPv4 or IPv6 address`]);
      else if (v === '::1' || v.startsWith('127.')) errors.push([`${schema}.${key}`, 'Loopback is not a valid nameserver']);
      else if (v === '0.0.0.0' || v === '::') errors.push([`${schema}.${key}`, 'Unspecified addresses are not valid as nameservers']);
      else if (v === '255.255.255.255') errors.push([`${schema}.${key}`, 'This is not a valid nameserver address']);
      else if (v.startsWith('169.254')) errors.push([`${schema}.${key}`, '169.254/16 subnet is not valid for nameserver']);
    });
    if (provided.some((v, idx) => idx > 0 && v !== provided[idx - 1]! + 1)) {
      errors.push([`${schema}.nameserver`, 'When providing nameservers, they must be provided in consecutive order (i.e. nameserver1, nameserver2, nameserver3)']);
    }
    const gw = data.ipv4gateway;
    if (gw !== undefined && gw !== '') {
      if (!isIpv4(gw)) errors.push([`${schema}.ipv4gateway`, 'Input is not a valid IPv4 address']);
      else if (!gatewayReachable(n, gw)) errors.push([`${schema}.ipv4gateway`, `Gateway ${gw} is unreachable`]);
    }
    if (errors.length) throw validationErrors(errors);
    if (typeof data.hostname === 'string') n.hostname = data.hostname;
    if (typeof data.domain === 'string') n.domain = data.domain;
    if (typeof gw === 'string') n.ipv4gateway = gw;
    (['nameserver1', 'nameserver2', 'nameserver3'] as const).forEach((k, idx) => {
      if (typeof data[k] === 'string') n.nameservers[idx] = data[k] as string;
    });
    const config = networkConfig(mock);
    mock.emit('network.config', 'changed', null, config);
    return config;
  });
  server.method('network.general.summary', () => {
    const n = mock.state.network;
    const ips: Obj = {};
    for (const i of n.interfaces) {
      if (i.live === false) continue;
      const v4 = i.addresses.map((a) => `${a.address}/${a.netmask}`);
      const v6 = i.linkUp ? [`${linkLocal(i.mac)}/64`] : [];
      if (v4.length || v6.length) ips[i.name] = { IPV4: v4, IPV6: v6 };
    }
    const gw = effectiveGateway(n);
    return { ips, default_routes: gw ? [gw] : [], nameservers: effectiveNameservers(n) };
  });
}

/** Clears timers that would outlive the simulator. */
export function stopNetwork(mock: Mock): void {
  clearTimeout(mock.network.rollbackTimer);
  mock.network.rollbackTimer = undefined;
}
