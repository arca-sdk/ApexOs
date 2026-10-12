import type { Mock } from '../context.ts';
import { queryFilter, validationErrors } from '../rpc.ts';
import type { InterfaceState } from '../state.ts';
import { argObj, type Obj } from '../util.ts';

const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

function linkLocal(mac: string): string {
  const b = mac.split(':').map((x) => parseInt(x, 16));
  b[0] = (b[0] ?? 0) ^ 0x02;
  const h = (i: number) => (b[i] ?? 0).toString(16).padStart(2, '0');
  return `fe80::${h(0)}${h(1)}:${h(2)}ff:fe${h(3)}:${h(4)}${h(5)}`.replace(/:0+([0-9a-f])/g, ':$1');
}

function broadcast(address: string, netmask: number): string {
  const n = address.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
  const mask = netmask === 0 ? 0 : (~0 << (32 - netmask)) >>> 0;
  const b = (n | (~mask >>> 0)) >>> 0;
  return [24, 16, 8, 0].map((s) => (b >>> s) & 255).join('.');
}

export function renderInterface(i: InterfaceState): Obj {
  const live = i.linkUp
    ? [
        ...i.addresses.map((a) => ({ type: 'INET', address: a.address, netmask: a.netmask, broadcast: broadcast(a.address, a.netmask) })),
        { type: 'INET6', address: linkLocal(i.mac), netmask: 64, broadcast: null },
        { type: 'LINK', address: i.mac },
      ]
    : [{ type: 'LINK', address: i.mac }];
  return {
    id: i.name,
    name: i.name,
    fake: false,
    type: 'PHYSICAL',
    description: i.description,
    mtu: null,
    ipv4_dhcp: i.ipv4_dhcp,
    ipv6_auto: false,
    aliases: i.aliases,
    state: {
      name: i.name,
      orig_name: i.name,
      description: i.description,
      mtu: i.mtu,
      cloned: false,
      flags: i.linkUp ? ['UP', 'BROADCAST', 'RUNNING', 'MULTICAST', 'LOWER_UP'] : ['UP', 'BROADCAST', 'MULTICAST'],
      nd6_flags: [],
      capabilities: ['RXCSUM', 'TXCSUM', 'TSO4', 'TSO6'],
      link_state: i.linkUp ? 'LINK_STATE_UP' : 'LINK_STATE_DOWN',
      media_type: 'Ethernet',
      media_subtype: i.linkUp ? `${i.speed}Mb/s Twisted Pair` : 'autoselect',
      active_media_type: 'Ethernet',
      active_media_subtype: i.linkUp ? `${i.speed}Mb/s Twisted Pair` : '',
      supported_media: ['10baseT/Half', '10baseT/Full', '100baseT/Half', '100baseT/Full', '1000baseT/Full'],
      media_options: null,
      link_address: i.mac,
      permanent_link_address: i.mac,
      hardware_link_address: i.mac,
      rx_queues: 4,
      tx_queues: 4,
      aliases: live,
      vrrp_config: [],
    },
    lag_ports: [],
    bridge_members: [],
  };
}

function networkConfig(mock: Mock): Obj {
  const n = mock.state.network;
  const dns = n.nameservers.some(Boolean) ? n.nameservers : [n.dhcp.nameservers[0] ?? '', n.dhcp.nameservers[1] ?? '', ''];
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
      ipv4gateway: n.ipv4gateway || n.dhcp.gateway,
      ipv6gateway: '',
      nameserver1: dns[0],
      nameserver2: dns[1],
      nameserver3: dns[2],
      hosts: [],
    },
  };
}

export function registerNetwork(mock: Mock): void {
  const { server } = mock;
  const ifaces = () => mock.state.network.interfaces.map(renderInterface);
  server.method('interface.query', (p) => queryFilter(ifaces(), p[0], p[1]));
  server.method('interface.get_instance', (p) => queryFilter(ifaces(), [['id', '=', p[0]]], { get: true }));
  server.method('interface.websocket_local_ip', () => mock.lanIp);
  server.method('interface.websocket_interface', () => ifaces()[0] ?? null);
  server.method('interface.has_pending_changes', () => false);
  server.method('interface.ip_in_use', () =>
    mock.state.network.interfaces.flatMap((i) => (i.linkUp ? i.addresses.map((a) => ({ type: 'INET', address: a.address, netmask: a.netmask, broadcast: broadcast(a.address, a.netmask) })) : [])),
  );
  server.method('network.configuration.config', () => networkConfig(mock));
  server.method('network.configuration.update', (p) => {
    const data = argObj(p[0], 'global_configuration_update');
    const n = mock.state.network;
    const errors: Array<[string, string]> = [];
    if ('hostname' in data && (typeof data.hostname !== 'string' || !HOSTNAME_RE.test(data.hostname))) {
      errors.push(['global_configuration_update.hostname', 'Invalid hostname: use letters, numbers and hyphens (max 63 characters).']);
    }
    for (const key of ['nameserver1', 'nameserver2', 'nameserver3', 'ipv4gateway']) {
      const v = data[key];
      if (v !== undefined && v !== '' && (typeof v !== 'string' || !IPV4_RE.test(v))) {
        errors.push([`global_configuration_update.${key}`, 'Not a valid IP address']);
      }
    }
    if (errors.length) throw validationErrors(errors);
    if (typeof data.hostname === 'string') n.hostname = data.hostname;
    if (typeof data.domain === 'string') n.domain = data.domain;
    if (typeof data.ipv4gateway === 'string') n.ipv4gateway = data.ipv4gateway;
    (['nameserver1', 'nameserver2', 'nameserver3'] as const).forEach((k, i) => {
      if (typeof data[k] === 'string') n.nameservers[i] = data[k] as string;
    });
    const config = networkConfig(mock);
    mock.emit('network.config', 'changed', null, config);
    return config;
  });
  server.method('network.general.summary', () => {
    const n = mock.state.network;
    const ips: Obj = {};
    for (const i of n.interfaces) {
      if (!i.linkUp) continue;
      ips[i.name] = { IPV4: i.addresses.map((a) => `${a.address}/${a.netmask}`), IPV6: [`${linkLocal(i.mac)}/64`] };
    }
    const ns = n.nameservers.filter(Boolean);
    return { ips, default_routes: [n.ipv4gateway || n.dhcp.gateway], nameservers: ns.length ? ns : n.dhcp.nameservers };
  });
}
