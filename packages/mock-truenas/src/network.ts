/**
 * Network model of the simulated server: configured interfaces (the middleware's database), what the
 * kernel has applied (live addresses), the home LAN the physical ports are plugged into (its router
 * hands out DHCP leases, a gateway and DNS servers) and whether clients on that LAN can still reach
 * the server.
 */
import { isIP } from 'node:net';
import type { InterfaceState, MockState } from './state.ts';

export type NetworkState = MockState['network'];

/** In-memory copy taken by the first staged interface change (`__save_datastores` in the middleware). */
export interface NetworkSnapshot {
  interfaces: InterfaceState[];
  ipv4gateway: string;
}

// ---------------------------------------------------------------------------
// IPv4 arithmetic
// ---------------------------------------------------------------------------

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export function isIpv4(s: unknown): s is string {
  return typeof s === 'string' && IPV4_RE.test(s);
}

export function isIpAddress(s: unknown): s is string {
  return typeof s === 'string' && isIP(s) !== 0;
}

export function ipv4ToInt(address: string): number {
  return address.split('.').reduce((n, o) => n * 256 + Number(o), 0);
}

export function intToIpv4(n: number): string {
  return [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join('.');
}

function maskInt(prefix: number): number {
  return prefix <= 0 ? 0 : (0xffffffff - (2 ** (32 - prefix) - 1)) >>> 0;
}

export function networkInt(address: string, prefix: number): number {
  return (ipv4ToInt(address) & maskInt(prefix)) >>> 0;
}

export function inSubnet(ip: string, address: string, prefix: number): boolean {
  return isIpv4(ip) && isIpv4(address) && networkInt(ip, prefix) === networkInt(address, prefix);
}

/** Whether two IPv4 networks share any address. */
export function networksOverlap(a: string, aPrefix: number, b: string, bPrefix: number): boolean {
  const p = Math.min(aPrefix, bPrefix);
  return networkInt(a, p) === networkInt(b, p);
}

export function broadcast(address: string, prefix: number): string {
  return intToIpv4(networkInt(address, prefix) + (2 ** (32 - prefix) - 1));
}

export function linkLocal(mac: string): string {
  const b = mac.split(':').map((x) => parseInt(x, 16));
  b[0] = (b[0] ?? 0) ^ 0x02;
  const h = (i: number) => (b[i] ?? 0).toString(16).padStart(2, '0');
  return `fe80::${h(0)}${h(1)}:${h(2)}ff:fe${h(3)}:${h(4)}${h(5)}`.replace(/:0+([0-9a-f])/g, ':$1');
}

// ---------------------------------------------------------------------------
// The simulated home network
// ---------------------------------------------------------------------------

interface DhcpScope {
  /** First three octets of the /24 the DHCP server hands out. */
  base: string;
  prefix: number;
  gateway: string;
  nameservers: string[];
}

/** The LAN the physical ports are plugged into: a /24 around the router (`dhcp.gateway`). */
export function lanScope(n: NetworkState): DhcpScope {
  const base = n.dhcp.gateway.split('.').slice(0, 3).join('.');
  return { base, prefix: 24, gateway: n.dhcp.gateway, nameservers: [...n.dhcp.nameservers] };
}

/** The DHCP server an interface talks to: the LAN router for physical ports, a per-VLAN router on 10.x.y.0/24 for VLANs. */
function dhcpScope(n: NetworkState, i: InterfaceState): DhcpScope {
  if (i.type !== 'VLAN' || !i.vlan) return lanScope(n);
  const base = `10.${Math.floor(i.vlan.tag / 256)}.${i.vlan.tag % 256}`;
  return { base, prefix: 24, gateway: `${base}.1`, nameservers: [`${base}.1`] };
}

export function isPhysical(i: InterfaceState): boolean {
  return (i.type ?? 'PHYSICAL') === 'PHYSICAL';
}

/** Fills in fields missing from states saved by older versions of the simulator. */
export function normalizeNetwork(n: NetworkState): void {
  for (const i of n.interfaces) {
    i.type ??= 'PHYSICAL';
    i.configured ??= i.ipv4_dhcp || i.aliases.length > 0;
    i.configuredMtu ??= null;
    i.live ??= true;
    if (i.ipv4_dhcp && !i.dhcpLease && i.addresses[0]) i.dhcpLease = i.addresses[0].address;
  }
}

/** With no interface in the database, TrueNAS runs DHCP on every port (fresh install). */
export function noneConfigured(n: NetworkState): boolean {
  return !n.interfaces.some((i) => i.configured);
}

/** `ipv4_dhcp` as `interface.query` reports it. */
export function reportedDhcp(n: NetworkState, i: InterfaceState): boolean {
  return i.configured ? i.ipv4_dhcp : noneConfigured(n);
}

/** Interfaces on which dhclient runs once the configuration is applied. */
function runsDhcp(n: NetworkState, i: InterfaceState): boolean {
  if (i.live === false) return false;
  return noneConfigured(n) ? isPhysical(i) : Boolean(i.configured && i.ipv4_dhcp);
}

function leaseFor(n: NetworkState, i: InterfaceState, taken: Set<string>): string | null {
  if (!i.linkUp) return null;
  const scope = dhcpScope(n, i);
  if (i.dhcpLease && i.dhcpLease.startsWith(`${scope.base}.`) && !taken.has(i.dhcpLease)) return i.dhcpLease;
  for (let host = 100; host < 250; host++) {
    const candidate = `${scope.base}.${host}`;
    if (!taken.has(candidate)) {
      i.dhcpLease = candidate;
      return candidate;
    }
  }
  return null;
}

/**
 * Applies the configuration to the "kernel" (`interface.sync`): creates/destroys VLANs, sets static
 * addresses, runs DHCP and unconfigures ports that have no database row.
 */
export function syncNetwork(n: NetworkState): void {
  const vlanKeys = new Set<string>();
  for (const i of n.interfaces) {
    if (isPhysical(i)) {
      i.live = true;
      i.mtu = i.configuredMtu ?? 1500;
      continue;
    }
    const parent = n.interfaces.find((p) => p.name === i.vlan?.parent && isPhysical(p));
    const key = `${i.vlan?.parent}.${i.vlan?.tag}`;
    // The kernel refuses a second VLAN with the same tag on the same parent.
    i.live = Boolean(parent && i.configured && !vlanKeys.has(key));
    if (i.live && parent) {
      vlanKeys.add(key);
      i.linkUp = parent.linkUp;
      i.speed = parent.speed;
      i.mac = parent.mac;
      i.mtu = Math.min(i.configuredMtu ?? parent.mtu, parent.mtu);
    } else {
      i.linkUp = false;
    }
  }
  // Static addresses first, so the DHCP server doesn't hand out an address that is already taken.
  const taken = new Set<string>();
  for (const i of n.interfaces) {
    const statics = i.live !== false && i.configured ? i.aliases.filter((a) => a.type === 'INET') : [];
    i.addresses = statics.map((a) => ({ address: a.address, netmask: a.netmask }));
    for (const a of statics) taken.add(a.address);
  }
  for (const i of n.interfaces) {
    if (!runsDhcp(n, i)) continue;
    const lease = leaseFor(n, i, taken);
    if (!lease) continue;
    taken.add(lease);
    i.addresses.unshift({ address: lease, netmask: dhcpScope(n, i).prefix });
  }
}

/** Takes the copy that a rollback restores (only the first staged change takes one). */
export function takeSnapshot(n: NetworkState): NetworkSnapshot {
  return { interfaces: structuredClone(n.interfaces), ipv4gateway: n.ipv4gateway };
}

/** Puts the configuration back as it was in `snapshot`; hardware facts (link, speed, MAC, leases) stay current. */
export function restoreSnapshot(n: NetworkState, snapshot: NetworkSnapshot): void {
  const current = new Map(n.interfaces.map((i) => [i.name, i]));
  n.interfaces = structuredClone(snapshot.interfaces).map((saved) => {
    const now = current.get(saved.name);
    if (now && isPhysical(saved)) Object.assign(saved, { linkUp: now.linkUp, speed: now.speed, mac: now.mac, dhcpLease: now.dhcpLease });
    return saved;
  });
  n.ipv4gateway = snapshot.ipv4gateway;
}

// ---------------------------------------------------------------------------
// Routes, DNS and reachability
// ---------------------------------------------------------------------------

function liveAddresses(n: NetworkState): Array<{ iface: InterfaceState; address: string; netmask: number }> {
  return n.interfaces.filter((i) => i.live !== false).flatMap((i) => i.addresses.map((a) => ({ iface: i, ...a })));
}

/** `route.ipv4gw_reachable`: the gateway lies in the network of a live address. */
export function gatewayReachable(n: NetworkState, gateway: string): boolean {
  return liveAddresses(n).some((a) => inSubnet(gateway, a.address, a.netmask));
}

function dhcpLeased(n: NetworkState): InterfaceState[] {
  return n.interfaces.filter((i) => runsDhcp(n, i) && i.dhcpLease && i.addresses.some((a) => a.address === i.dhcpLease));
}

/** The IPv4 default route the kernel has: the configured gateway, else the router of a DHCP lease. */
export function effectiveGateway(n: NetworkState): string | null {
  if (n.ipv4gateway) return gatewayReachable(n, n.ipv4gateway) ? n.ipv4gateway : null;
  const leased = dhcpLeased(n)[0];
  return leased ? dhcpScope(n, leased).gateway : null;
}

/** What ends up in resolv.conf: the configured name servers, else the ones DHCP handed out. */
export function effectiveNameservers(n: NetworkState): string[] {
  const configured = n.nameservers.filter(Boolean);
  if (configured.length) return configured;
  return [...new Set(dhcpLeased(n).flatMap((i) => dhcpScope(n, i).nameservers))];
}

/** Clients live on the LAN: they reach the server only through a physical port with an address on that LAN. */
export function reachableFromLan(n: NetworkState): boolean {
  const lan = lanScope(n);
  return n.interfaces.some(
    (i) => isPhysical(i) && i.linkUp && i.addresses.some((a) => a.address.startsWith(`${lan.base}.`)),
  );
}

/** The address clients on the LAN use (what `interface.websocket_local_ip` reports). */
export function primaryAddress(n: NetworkState): string {
  const lan = lanScope(n);
  const up = n.interfaces.filter((i) => i.live !== false && i.linkUp);
  const onLan = up.filter(isPhysical).flatMap((i) => i.addresses).find((a) => a.address.startsWith(`${lan.base}.`));
  return onLan?.address ?? up.flatMap((i) => i.addresses)[0]?.address ?? '127.0.0.1';
}

/** Every address currently assigned to an interface. */
export function assignedAddresses(n: NetworkState): Set<string> {
  return new Set(liveAddresses(n).map((a) => a.address));
}
