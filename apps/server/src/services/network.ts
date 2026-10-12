/**
 * Network settings: reading the configuration and changing it without locking anyone out.
 *
 * TrueNAS stages interface changes (`interface.update/create/delete`), applies them with
 * `interface.commit` and undoes them by itself unless `interface.checkin` follows within the
 * check-in timeout. Every change ApexOs makes goes through that safety net:
 *
 *  1. remember the current DNS servers and gateway;
 *  2. save new DNS servers first: they keep working when a DHCP lease goes away, and TrueNAS doesn't
 *     include them in its rollback copy, so ApexOs puts them back itself if needed;
 *  3. stage the interface change, then the gateway (now part of TrueNAS's rollback copy);
 *  4. commit with automatic rollback;
 *  5. reach TrueNAS again, at its new address if the one ApexOs uses changed;
 *  6. check in.
 *
 * If ApexOs can't get through in time, TrueNAS undoes the change on its own. ApexOs then reconnects
 * to the previous address, restores the DNS servers and reports that the old settings are back.
 */
import type {
  DnsChangeRequest,
  InterfaceChangeRequest,
  NetworkAddress,
  NetworkInterfaceSettings,
  NetworkMode,
  NetworkRestoreStep,
  NetworkSettings,
  Task,
  VlanCreateRequest,
} from '@apexos/api-types';
import { TrueNasConnectionError, TrueNasError, type TrueNasClient } from '@apexos/truenas-client';
import type { AppContext } from '../app.ts';
import { UserError } from '../lib/errors.ts';
import { cidr, hostAddressProblem, inSubnet, isIPv4, nameserverProblem, overlaps } from '../lib/ipv4.ts';
import type { TaskContext } from '../lib/tasks.ts';

/** Timings of the apply/confirm cycle. Tests shorten them. */
export const networkTimings = {
  /** Seconds TrueNAS waits for ApexOs to confirm a change before undoing it. */
  checkinTimeoutSeconds: Number(process.env.APEXOS_NETWORK_CHECKIN_TIMEOUT) || 60,
  /** After that deadline, how long ApexOs keeps trying to reach TrueNAS at its previous address. */
  graceMs: 45_000,
  /** Pause between connection attempts. */
  retryMs: 1_000,
  /** Longest a single connection attempt or liveness check may take. */
  attemptTimeoutMs: 8_000,
  /** Longest ApexOs waits for `interface.commit` to answer before assuming the connection was cut. */
  commitTimeoutMs: 20_000,
};

const TASK_TYPE = 'network';

const STEP = {
  check: 'Checking the current settings',
  dns: 'Saving DNS servers',
  gateway: 'Saving the gateway',
  stage: 'Staging the change',
  createVlan: 'Creating the VLAN',
  removeVlan: 'Removing the VLAN',
  apply: 'Applying (TrueNAS undoes this automatically if ApexOs can’t confirm)',
  reconnect: 'Reconnecting',
  confirm: 'Confirming',
  finish: 'Finishing up',
  verifyConnection: 'Checking the connection',
  restore: 'Restoring your previous settings' satisfies NetworkRestoreStep,
} as const;

// ---------------------------------------------------------------------------
// What TrueNAS returns
// ---------------------------------------------------------------------------

interface TnAlias {
  type?: string;
  address: string;
  netmask?: number | string;
}

interface TnIface {
  id: string;
  name: string;
  type: string;
  fake?: boolean;
  ipv4_dhcp: boolean;
  ipv6_auto?: boolean;
  description?: string;
  mtu?: number | null;
  aliases: TnAlias[];
  vlan_parent_interface?: string | null;
  vlan_tag?: number | null;
  state: {
    link_state: string;
    link_address: string | null;
    active_media_subtype?: string | null;
    aliases: TnAlias[];
  };
}

interface TnNetConfig {
  hostname: string;
  domain: string;
  ipv4gateway: string;
  nameserver1: string;
  nameserver2: string;
  nameserver3: string;
}

interface TnSummary {
  ips: Record<string, { IPV4?: string[]; IPV6?: string[] }>;
  default_routes: string[];
  nameservers: string[];
}

/** Everything ApexOs needs to know before changing the network. */
interface NetState {
  config: TnNetConfig;
  summary: TnSummary;
  interfaces: TnIface[];
  /** Server address of ApexOs's connection (`interface.websocket_local_ip`). */
  localIp: string | null;
  rollbackSecondsLeft: number | null;
  pendingChanges: boolean;
}

async function readNetwork(client: TrueNasClient): Promise<NetState> {
  const [config, summary, interfaces, localIp, rollbackSecondsLeft, pendingChanges] = await Promise.all([
    client.call<TnNetConfig>('network.configuration.config'),
    client.call<TnSummary>('network.general.summary'),
    client.call<TnIface[]>('interface.query'),
    client.call<string | null>('interface.websocket_local_ip').catch(() => null),
    client.call<number | null>('interface.checkin_waiting').catch(() => null),
    client.call<boolean>('interface.has_pending_changes').catch(() => false),
  ]);
  return { config, summary, interfaces, localIp, rollbackSecondsLeft, pendingChanges };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** IPv4 entries of an alias list. */
function v4(aliases: TnAlias[]): NetworkAddress[] {
  return aliases
    .filter((a) => (a.type ?? 'INET') === 'INET' && isIPv4(a.address))
    .map((a) => ({ address: a.address, prefix: a.netmask === undefined ? 32 : Number(a.netmask) }));
}

function configuredNameservers(config: TnNetConfig): string[] {
  return [config.nameserver1, config.nameserver2, config.nameserver3].filter(Boolean);
}

function modeOf(i: TnIface): NetworkMode {
  return i.ipv4_dhcp ? 'dhcp' : v4(i.aliases).length ? 'static' : 'none';
}

function editable(i: TnIface): boolean {
  return i.type === 'PHYSICAL' || i.type === 'VLAN';
}

function usedByApexOs(i: TnIface, localIp: string | null): boolean {
  return !!localIp && [...i.aliases, ...i.state.aliases].some((a) => a.address === localIp);
}

/**
 * A fresh install has no interface configuration: TrueNAS reports DHCP and IPv6 autoconfiguration
 * on every port. The first change then tears down every port that isn't configured, so ApexOs pins
 * the port it relies on to DHCP before changing anything else.
 */
function isFresh(interfaces: TnIface[]): boolean {
  const physical = interfaces.filter((i) => i.type === 'PHYSICAL');
  return physical.length > 0 && interfaces.every((i) => i.type === 'PHYSICAL' && i.ipv4_dhcp && i.ipv6_auto === true);
}

const ORDER = (i: TnIface) => (i.type === 'PHYSICAL' ? 0 : i.type === 'VLAN' ? 2 : 1);

/**
 * The server's main connection, chosen the same way every time even with several ports: the one
 * ApexOs talks through, else the one whose network holds the default gateway, else the first
 * physical port (by name) with an address.
 */
function primaryInterface(state: NetState): TnIface | undefined {
  const sorted = [...state.interfaces].sort((a, b) => ORDER(a) - ORDER(b) || a.name.localeCompare(b.name));
  const byLocal = sorted.find((i) => usedByApexOs(i, state.localIp));
  if (byLocal) return byLocal;
  const gw = state.summary.default_routes.find(isIPv4);
  const byGateway = gw ? sorted.find((i) => v4(i.state.aliases).some((a) => inSubnet(gw, a.address, a.prefix))) : undefined;
  return byGateway ?? sorted.find((i) => v4(i.state.aliases).length > 0);
}

/** TrueNAS allows DHCP on one configured connection only. */
function dhcpInterface(state: NetState): string | null {
  if (isFresh(state.interfaces)) return primaryInterface(state)?.name ?? null;
  return state.interfaces.find((i) => i.ipv4_dhcp && !i.fake)?.name ?? null;
}

/**
 * A stable LAN address for links shown to the user when TrueNAS can't say which one ApexOs uses:
 * the address in the default gateway's network, physical ports before others, by name.
 */
export function stableLanAddress(summary: TnSummary): string | null {
  const gw = summary.default_routes.find(isIPv4);
  const rank = (name: string) => (/^(vlan|br|bond)/.test(name) ? 1 : 0);
  const entries = Object.entries(summary.ips)
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .flatMap(([, ips]) => (ips.IPV4 ?? []).map((cidrText) => {
      const [address, prefix] = cidrText.split('/');
      return { address: address!, prefix: Number(prefix ?? 32) };
    }))
    .filter((a) => isIPv4(a.address) && !a.address.startsWith('127.'));
  return (gw ? entries.find((a) => inSubnet(gw, a.address, a.prefix)) : undefined)?.address ?? entries[0]?.address ?? null;
}

function speedMbps(i: TnIface): number | null {
  const speed = i.state.active_media_subtype?.match(/(\d+)\s*(G|M)b/i);
  return speed ? Number(speed[1]) * (speed[2]!.toUpperCase() === 'G' ? 1000 : 1) : null;
}

function toSettings(i: TnIface, localIp: string | null): NetworkInterfaceSettings {
  return {
    name: i.name,
    type: i.type,
    linkUp: i.state.link_state === 'LINK_STATE_UP',
    speedMbps: speedMbps(i),
    mac: i.state.link_address || null,
    dhcp: i.ipv4_dhcp,
    addresses: i.state.aliases
      .filter((a) => a.type === 'INET' || a.type === 'INET6')
      .map((a) => `${a.address}${a.netmask !== undefined ? `/${a.netmask}` : ''}`),
    mode: modeOf(i),
    configuredAddresses: v4(i.aliases),
    liveAddresses: v4(i.state.aliases),
    description: i.description ?? '',
    mtu: i.mtu ?? null,
    vlan: i.type === 'VLAN' ? { parent: i.vlan_parent_interface ?? '', tag: i.vlan_tag ?? 0 } : null,
    usedByApexOs: usedByApexOs(i, localIp),
    editable: editable(i),
    applied: !i.fake,
  };
}

export async function getNetworkSettings(ctx: AppContext): Promise<NetworkSettings> {
  const state = await readNetwork(ctx.truenas.client());
  const { config, summary } = state;
  const ns = configuredNameservers(config);
  return {
    hostname: config.hostname,
    domain: config.domain,
    gateway: summary.default_routes ?? [],
    nameservers: summary.nameservers ?? [],
    interfaces: [...state.interfaces]
      .sort((a, b) => ORDER(a) - ORDER(b) || a.name.localeCompare(b.name))
      .map((i) => toSettings(i, state.localIp)),
    configuredGateway: config.ipv4gateway,
    configuredNameservers: ns,
    gatewayFromDhcp: !config.ipv4gateway && summary.default_routes.length > 0,
    nameserversFromDhcp: !ns.length && summary.nameservers.length > 0,
    dhcpInterface: dhcpInterface(state),
    apexosAddress: state.localIp && state.localIp !== '127.0.0.1' && state.localIp !== '::1' ? state.localIp : null,
    pendingChanges: state.pendingChanges && state.rollbackSecondsLeft === null,
    rollbackSecondsLeft: state.rollbackSecondsLeft,
    checkinTimeoutSeconds: networkTimings.checkinTimeoutSeconds,
  };
}

// ---------------------------------------------------------------------------
// Validation and planning
// ---------------------------------------------------------------------------

type Fields = Record<string, string>;

function failIfInvalid(fields: Fields): void {
  if (Object.keys(fields).length) throw new UserError('Some settings need attention.', 400, 'VALIDATION', fields);
}

function assertIdle(ctx: AppContext, state: NetState): void {
  if (ctx.tasks.findRunning(TASK_TYPE)) throw new UserError('Another network change is still in progress. Wait for it to finish.', 409, 'BUSY');
  if (state.rollbackSecondsLeft !== null) {
    throw new UserError(
      'TrueNAS is trying out other network changes right now (probably from the TrueNAS web interface). Try again once they are kept or undone.',
      409,
      'BUSY',
    );
  }
  if (state.pendingChanges) {
    throw new UserError('TrueNAS has network changes that were never applied. Discard them first.', 409, 'PENDING_CHANGES');
  }
}

/** Checks a fixed address for a connection; returns it when valid. */
function checkStaticAddress(
  fields: Fields,
  others: TnIface[],
  address: string | undefined,
  prefix: number | undefined,
): NetworkAddress | null {
  const value = (address ?? '').trim();
  if (!value) {
    fields.address = 'Enter the address the server should use';
    return null;
  }
  if (prefix === undefined) {
    fields.prefix = 'Choose the subnet mask';
    return null;
  }
  const problem = hostAddressProblem(value, prefix);
  if (problem) {
    fields.address = problem;
    return null;
  }
  const user = others.find((o) => [...v4(o.aliases), ...v4(o.state.aliases)].some((a) => a.address === value));
  if (user) {
    fields.address = `${value} is already used by ${user.name}.`;
    return null;
  }
  const clash = others.find((o) => v4(o.aliases).some((a) => overlaps(a.address, a.prefix, value, prefix)));
  if (clash) {
    fields.address = `The network ${cidr(value, prefix)} is already used by ${clash.name}. Each connection needs its own network.`;
    return null;
  }
  return { address: value, prefix };
}

function checkNameservers(fields: Fields, nameservers: string[]): void {
  if (nameservers.length > 3) fields.nameservers = 'Enter up to three DNS servers';
  nameservers.forEach((ns, idx) => {
    const problem = nameserverProblem(ns) ?? (nameservers.indexOf(ns) !== idx ? 'Listed twice' : null);
    if (problem) fields[`nameservers.${idx}`] = problem;
  });
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function aliasKey(aliases: TnAlias[]): string {
  return aliases.map((a) => `${a.type ?? 'INET'}:${a.address}/${a.netmask}`).join(',');
}

interface InterfacePlan {
  name: string;
  /** The staged interface change; null when only DNS servers or the gateway change. */
  update: { ipv4_dhcp: boolean; aliases: TnAlias[] } | null;
  /** DNS servers to save before the interface change (null: no change). */
  nameservers: string[] | null;
  /** New gateway ('' = from DHCP; null: no change). */
  gateway: string | null;
  /** Fresh install: port to pin to DHCP first so it keeps its address. */
  pin: string | null;
  /** Fixed address the connection gets (null for DHCP or no interface change). */
  newAddress: string | null;
  usesApexOs: boolean;
  /** Networks with a fixed address after the change (where `interface.save_network_config` accepts a gateway). */
  staticNetworks: NetworkAddress[];
}

export function planInterfaceChange(state: NetState, name: string, req: InterfaceChangeRequest): InterfacePlan {
  const iface = state.interfaces.find((i) => i.name === name);
  if (!iface) throw new UserError(`There is no network connection called ${name}.`, 404, 'NOT_FOUND');
  if (!editable(iface)) {
    throw new UserError(`${name} is a ${iface.type === 'BRIDGE' ? 'bridge' : 'bond'}. Change it in the TrueNAS web interface.`, 400, 'NOT_SUPPORTED');
  }
  const fields: Fields = {};
  const others = state.interfaces.filter((i) => i !== iface);
  const dhcpIface = dhcpInterface(state);

  const primary = req.mode === 'static' ? checkStaticAddress(fields, others, req.address, req.prefix) : null;
  if (req.mode === 'dhcp' && dhcpIface && dhcpIface !== name) {
    fields.mode = `Only one connection can get its address automatically, and ${dhcpIface} already does. Give ${name} a fixed address instead.`;
  }
  const extra = req.mode === 'static' ? v4(iface.aliases).slice(1).filter((a) => a.address !== primary?.address) : [];
  const ownNetworks = primary ? [primary, ...extra] : req.mode === 'dhcp' ? v4(iface.state.aliases) : [];
  const reachableNetworks = [...ownNetworks, ...others.flatMap((o) => [...v4(o.state.aliases), ...v4(o.aliases)])];

  // Does any connection still get the gateway and DNS servers from DHCP after the change?
  const dhcpRemains = req.mode === 'dhcp' || (dhcpIface !== null && dhcpIface !== name);

  const configuredGw = state.config.ipv4gateway;
  let gateway = req.gateway === undefined ? configuredGw : req.gateway.trim();
  if (req.gateway === undefined && !gateway && !dhcpRemains) {
    // Leaving DHCP: keep using the router the server uses now.
    const current = state.summary.default_routes.find(isIPv4);
    if (current && reachableNetworks.some((n) => inSubnet(current, n.address, n.prefix))) gateway = current;
  }
  if (gateway) {
    if (!isIPv4(gateway)) fields.gateway = 'Enter an IPv4 address like 192.168.1.1';
    else if (gateway === primary?.address) fields.gateway = 'The gateway is your router, not the server itself';
    else if (!fields.address && !reachableNetworks.some((n) => inSubnet(gateway, n.address, n.prefix))) {
      fields.gateway = primary
        ? `The gateway must be in the server’s network (${cidr(primary.address, primary.prefix)})`
        : 'The gateway must be in the same network as one of the server’s addresses';
    }
  } else if (!dhcpRemains) {
    fields.gateway = 'Enter your router’s address (it often ends in .1) so the server can reach the internet';
  }

  const configuredNs = configuredNameservers(state.config);
  let nameservers = req.nameservers === undefined ? configuredNs : req.nameservers.map((s) => s.trim()).filter(Boolean);
  if (req.nameservers === undefined && !nameservers.length && !dhcpRemains) {
    // DNS before static: keep the servers DHCP handed out, or the server can't look up names afterwards.
    nameservers = state.summary.nameservers.filter((ns) => !nameserverProblem(ns)).slice(0, 3);
  }
  checkNameservers(fields, nameservers);
  if (!nameservers.length && !dhcpRemains) fields.nameservers = 'Enter at least one DNS server (your router’s address usually works)';
  failIfInvalid(fields);

  const toAlias = (a: NetworkAddress): TnAlias => ({ type: 'INET', address: a.address, netmask: a.prefix });
  const inet6 = iface.aliases.filter((a) => a.type === 'INET6').map((a) => ({ type: 'INET6', address: a.address, netmask: Number(a.netmask) }));
  const aliases = [...(primary ? [primary, ...extra].map(toAlias) : []), ...inet6];
  const changed = iface.ipv4_dhcp !== (req.mode === 'dhcp') || aliasKey(iface.aliases) !== aliasKey(aliases);
  const nsChanged = !sameList(nameservers, configuredNs);
  const gwChanged = gateway !== configuredGw;
  if (!changed && !nsChanged && !gwChanged) throw new UserError('These are already the current settings.', 400, 'NO_CHANGES');

  const keep = isFresh(state.interfaces) ? primaryInterface(state)?.name : undefined;
  return {
    name,
    update: changed ? { ipv4_dhcp: req.mode === 'dhcp', aliases } : null,
    nameservers: nsChanged ? nameservers : null,
    gateway: gwChanged ? gateway : null,
    pin: changed && keep && keep !== name ? keep : null,
    newAddress: changed && primary ? primary.address : null,
    usesApexOs: changed && usedByApexOs(iface, state.localIp),
    staticNetworks: [...(primary ? [primary, ...extra] : []), ...others.flatMap((o) => v4(o.aliases))],
  };
}

export function planDnsChange(state: NetState, req: DnsChangeRequest): { nameservers: string[] | null; gateway: string | null } {
  const fields: Fields = {};
  const dhcpRemains = dhcpInterface(state) !== null;
  const nameservers = req.nameservers.map((s) => s.trim()).filter(Boolean);
  checkNameservers(fields, nameservers);
  if (!nameservers.length && !dhcpRemains) fields.nameservers = 'No connection gets DNS servers automatically, so enter at least one';
  const gateway = req.gateway.trim();
  if (gateway) {
    const live = state.interfaces.flatMap((i) => v4(i.state.aliases));
    if (!isIPv4(gateway)) fields.gateway = 'Enter an IPv4 address like 192.168.1.1';
    else if (live.some((a) => a.address === gateway)) fields.gateway = 'The gateway is your router, not the server itself';
    else if (!live.some((a) => inSubnet(gateway, a.address, a.prefix))) {
      fields.gateway = `The gateway must be in the same network as one of the server’s addresses (${live.map((a) => cidr(a.address, a.prefix)).join(', ') || 'none'})`;
    }
  } else if (!dhcpRemains) {
    fields.gateway = 'No connection gets a gateway automatically, so enter your router’s address';
  }
  failIfInvalid(fields);
  const nsChanged = !sameList(nameservers, configuredNameservers(state.config));
  const gwChanged = gateway !== state.config.ipv4gateway;
  if (!nsChanged && !gwChanged) throw new UserError('These are already the current settings.', 400, 'NO_CHANGES');
  return { nameservers: nsChanged ? nameservers : null, gateway: gwChanged ? gateway : null };
}

interface VlanPlan {
  name: string | undefined;
  create: Record<string, unknown>;
  pin: string | null;
}

export function planVlan(state: NetState, req: VlanCreateRequest): VlanPlan {
  const fields: Fields = {};
  const parent = state.interfaces.find((i) => i.name === req.parent);
  if (!parent) fields.parent = 'Choose the network port the VLAN runs on';
  else if (parent.type !== 'PHYSICAL') fields.parent = 'VLANs can only be added to a physical network port';
  if (!Number.isInteger(req.tag) || req.tag < 1 || req.tag > 4094) fields.tag = 'Use a VLAN number from 1 to 4094';
  const twin = state.interfaces.find((i) => i.type === 'VLAN' && i.vlan_parent_interface === req.parent && i.vlan_tag === req.tag);
  if (parent && !fields.tag && twin) fields.tag = `${req.parent} already has VLAN ${req.tag} (${twin.name})`;
  const description = (req.description ?? '').trim();
  if (description.length > 120) fields.description = 'Keep the description under 120 characters';
  const dhcpIface = dhcpInterface(state);
  const address = req.mode === 'static' ? checkStaticAddress(fields, state.interfaces, req.address, req.prefix) : null;
  if (req.mode === 'dhcp' && dhcpIface) {
    fields.mode = `Only one connection can get its address automatically, and ${dhcpIface} already does. Give the VLAN a fixed address instead.`;
  }
  failIfInvalid(fields);
  const preferred = `vlan${req.tag}`;
  const name = state.interfaces.some((i) => i.name === preferred) ? undefined : preferred;
  const keep = isFresh(state.interfaces) ? (primaryInterface(state)?.name ?? null) : null;
  return {
    name,
    pin: keep,
    create: {
      type: 'VLAN',
      ...(name ? { name } : {}),
      vlan_parent_interface: req.parent,
      vlan_tag: req.tag,
      ipv4_dhcp: req.mode === 'dhcp',
      aliases: address ? [{ type: 'INET', address: address.address, netmask: address.prefix }] : [],
      description,
    },
  };
}

export function planVlanDelete(state: NetState, name: string): void {
  const iface = state.interfaces.find((i) => i.name === name);
  if (!iface) throw new UserError(`There is no VLAN called ${name}.`, 404, 'NOT_FOUND');
  if (iface.type !== 'VLAN') throw new UserError(`${name} is not a VLAN. Only VLANs can be removed.`, 400, 'NOT_SUPPORTED');
  if (usedByApexOs(iface, state.localIp)) {
    throw new UserError(`ApexOs talks to TrueNAS through ${name}, so removing it would cut ApexOs off. Connect ApexOs through another address first.`, 409, 'IN_USE');
  }
  const rest = state.interfaces.filter((i) => i !== iface);
  if (!rest.some((i) => i.ipv4_dhcp || i.ipv6_auto || i.aliases.length)) {
    throw new UserError(`${name} is the only connection with an address. Removing it would make the server unreachable.`, 409, 'LAST_CONNECTION');
  }
  if (iface.ipv4_dhcp && (!configuredNameservers(state.config).length || !state.config.ipv4gateway)) {
    throw new UserError(
      `The server gets its DNS servers and gateway through ${name}. Set them by hand under Internet access first, so the server stays online.`,
      409,
      'NEEDS_DNS',
    );
  }
}

// ---------------------------------------------------------------------------
// Applying changes safely
// ---------------------------------------------------------------------------

interface Saved {
  nameservers: [string, string, string];
  gateway: string;
  /** URL ApexOs used to reach TrueNAS before the change. */
  url: string;
}

const seconds = (n: number) => `${n} second${n === 1 ? '' : 's'}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

class TimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError('Timed out')), Math.max(1, ms));
  });
  promise.catch(() => undefined);
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function connectionLost(err: unknown): boolean {
  return err instanceof TimeoutError || err instanceof TrueNasConnectionError || (err instanceof TrueNasError && err.errname === 'ETIMEDOUT');
}

/** A TrueNAS error in words a person can act on. */
function explain(err: unknown): Error {
  if (err instanceof TrueNasError) {
    const details = Object.values(err.validationErrors);
    return new UserError(`TrueNAS refused the change: ${details.length ? details.join(' ') : (err.reason ?? err.message)}`, 400, 'TRUENAS_REFUSED');
  }
  return err instanceof Error ? err : new Error(String(err));
}

function padNameservers(list: string[]): Record<string, string> {
  return { nameserver1: list[0] ?? '', nameserver2: list[1] ?? '', nameserver3: list[2] ?? '' };
}

async function saveCurrent(ctx: AppContext): Promise<Saved> {
  const client = ctx.truenas.client();
  const config = await client.call<TnNetConfig>('network.configuration.config');
  return {
    nameservers: [config.nameserver1, config.nameserver2, config.nameserver3],
    gateway: config.ipv4gateway,
    url: ctx.truenas.url ?? '',
  };
}

/** Puts DNS servers and gateway back the way they were before the change (best effort). */
async function restoreGlobals(client: TrueNasClient, saved: Saved): Promise<string[]> {
  const problems: string[] = [];
  const config = await client.call<TnNetConfig>('network.configuration.config');
  if (!sameList([config.nameserver1, config.nameserver2, config.nameserver3], saved.nameservers)) {
    await client
      .call('network.configuration.update', [padNameservers(saved.nameservers)])
      .catch((err: Error) => problems.push(`DNS servers: ${explain(err).message}`));
  }
  if (config.ipv4gateway !== saved.gateway) {
    await client
      .call('network.configuration.update', [{ ipv4gateway: saved.gateway }])
      .catch((err: Error) => problems.push(`gateway: ${explain(err).message}`));
  }
  return problems;
}

/** Drops staged (not yet applied) changes and restores the DNS servers. */
async function discardStaged(ctx: AppContext, saved: Saved): Promise<void> {
  const client = ctx.truenas.client();
  await client.call('interface.rollback').catch(() => undefined);
  await restoreGlobals(client, saved).catch(() => undefined);
}

async function alive(ctx: AppContext): Promise<boolean> {
  if (!ctx.truenas.connected) return false;
  try {
    await withTimeout(ctx.truenas.client().call('core.ping'), networkTimings.attemptTimeoutMs);
    return true;
  } catch {
    return false;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return url;
  }
}

function withHost(url: string, host: string): string {
  const u = new URL(url);
  u.hostname = host;
  return u.toString();
}

/** Keeps trying to talk to TrueNAS (current connection first, then `urls`) until `until`. */
async function reach(ctx: AppContext, urls: string[], until: number, onTry: (url: string) => void): Promise<string | null> {
  for (;;) {
    if (await alive(ctx)) return ctx.truenas.url ?? null;
    for (const url of urls) {
      const left = until - Date.now();
      if (left <= 0) return null;
      onTry(url);
      try {
        await withTimeout(ctx.truenas.connectTo(url), Math.min(networkTimings.attemptTimeoutMs, left));
        if (await alive(ctx)) return url;
      } catch {
        // Not reachable (yet).
      }
    }
    if (Date.now() >= until) return null;
    await sleep(Math.min(networkTimings.retryMs, until - Date.now()));
  }
}

/** Addresses to try after the change, while TrueNAS waits (`during`) and after it undid the change (`after`). */
function candidateUrls(
  saved: Saved,
  opts: { usesApexOs: boolean; localIp: string | null; newAddress: string | null; hostname: string; domain: string },
): { during: string[]; after: string[] } {
  const current = saved.url;
  if (!current || !opts.usesApexOs || !opts.localIp || hostOf(current) !== opts.localIp) return { during: [current], after: [current] };
  const during: string[] = [];
  if (opts.newAddress) during.push(withHost(current, opts.newAddress));
  else {
    // Automatic addressing: the router may hand out the same address again, or the name may resolve.
    during.push(current);
    if (opts.hostname) during.push(withHost(current, `${opts.hostname}.local`));
    if (opts.hostname && opts.domain && opts.domain !== 'local') during.push(withHost(current, `${opts.hostname}.${opts.domain}`));
  }
  return { during: [...new Set([...during, current])], after: [...new Set([current, ...during])] };
}

interface ApplyOptions {
  ctx: AppContext;
  t: TaskContext;
  saved: Saved;
  stageStep: string;
  stage: (client: TrueNasClient) => Promise<void>;
  /** After the check-in: whether TrueNAS really kept the change. */
  verify: (client: TrueNasClient) => Promise<boolean>;
  urls: { during: string[]; after: string[] };
  /** "at its new address 192.168.1.50": where ApexOs looks for the server. */
  where: string;
}

type ApplyResult = { ok: true; url: string } | { ok: false; reason: string };

/** Stage → commit with rollback → reconnect → check in; on failure, wait for TrueNAS's rollback and restore DNS. */
async function applyAndConfirm(o: ApplyOptions): Promise<ApplyResult> {
  const { ctx, t } = o;
  const timeout = networkTimings.checkinTimeoutSeconds;

  await t.step(o.stageStep, async () => {
    try {
      await o.stage(ctx.truenas.client());
    } catch (err) {
      await discardStaged(ctx, o.saved);
      throw explain(err);
    }
  });

  let deadline = 0;
  await t.step(STEP.apply, async () => {
    try {
      await withTimeout(ctx.truenas.client().call('interface.commit', [{ rollback: true, checkin_timeout: timeout }]), networkTimings.commitTimeoutMs);
    } catch (err) {
      if (!connectionLost(err)) {
        await discardStaged(ctx, o.saved);
        throw explain(err);
      }
      // The connection dropped while TrueNAS applied the change: expected when ApexOs's address changes.
    } finally {
      deadline = Date.now() + timeout * 1000;
    }
  });

  let trying = '';
  let reached: string | null = null;
  try {
    reached = await t.step(STEP.reconnect, async (report) => {
      const tick = () => {
        const left = Math.ceil((deadline - Date.now()) / 1000);
        const target = trying ? `Trying ${hostOf(trying)}. ` : '';
        report(
          Math.min(99, ((timeout * 1000 - (deadline - Date.now())) / (timeout * 1000)) * 100),
          left > 0
            ? `${target}TrueNAS undoes the change in ${left} s unless ApexOs confirms it.`
            : `TrueNAS is putting the previous settings back. ${target}`.trim(),
        );
      };
      const timer = setInterval(tick, 1000);
      try {
        const during = await reach(ctx, o.urls.during, deadline, (url) => {
          trying = url;
          tick();
        });
        const url = during ?? (await reach(ctx, o.urls.after, deadline + networkTimings.graceMs, (u) => {
          trying = u;
          tick();
        }));
        if (!url) throw new Error('ApexOs can’t reach the server anymore.');
        return url;
      } finally {
        clearInterval(timer);
      }
    });
  } catch {
    // Reported below.
  }

  let reason: string;
  if (reached) {
    const late = Date.now() > deadline;
    try {
      await t.step(STEP.confirm, async () => {
        const client = ctx.truenas.client();
        const waiting = await client.call<number | null>('interface.checkin_waiting');
        if (waiting === null) {
          if (await client.call<boolean>('interface.has_pending_changes')) {
            await client.call('interface.rollback');
            throw new Error('TrueNAS never applied the change.');
          }
          throw new Error('TrueNAS had already undone the change.');
        }
        await client.call('interface.checkin');
        if (!(await o.verify(client))) throw new Error('TrueNAS undid the change before ApexOs could confirm it.');
      });
      return { ok: true, url: reached };
    } catch (err) {
      reason = late
        ? `ApexOs couldn’t reach the server ${o.where} within ${seconds(timeout)}`
        : `TrueNAS didn’t keep the change (${(err as Error).message.replace(/\.$/, '')})`;
    }
  } else {
    t.skip(STEP.confirm, 'Not possible without a connection');
    reason = `ApexOs couldn’t reach the server ${o.where} within ${seconds(timeout)}`;
  }

  await t.step(STEP.restore, async () => {
    if (!reached || !(await alive(ctx))) {
      throw new Error(
        `ApexOs can’t reach the server. TrueNAS puts the previous network settings back by itself ${seconds(timeout)} after a change; if the server stays unreachable, check its screen or your router.`,
      );
    }
    const client = ctx.truenas.client();
    // Let TrueNAS finish its own rollback first.
    const until = Date.now() + networkTimings.graceMs;
    while ((await client.call<number | null>('interface.checkin_waiting')) !== null && Date.now() < until) await sleep(500);
    if (await client.call<boolean>('interface.has_pending_changes')) await client.call('interface.rollback');
    const problems = await restoreGlobals(client, o.saved);
    if (problems.length) throw new Error(`The connection settings are back, but restoring the ${problems.join('; ')} failed.`);
  });
  return { ok: false, reason };
}

/** Remembers a new TrueNAS address so ApexOs uses it after a restart too. */
async function rememberUrl(ctx: AppContext, saved: Saved, url: string): Promise<void> {
  if (url === saved.url) return;
  const stored = ctx.store.get().truenas;
  if (stored?.url !== saved.url) return;
  await ctx.store.update((s) => {
    if (s.truenas) s.truenas.url = url;
  });
}

async function readInterface(client: TrueNasClient, name: string): Promise<TnIface | undefined> {
  return (await client.call<TnIface[]>('interface.query', [[['name', '=', name]]]))[0];
}

/** Stages the gateway after the interface change, so it is part of TrueNAS's rollback copy. */
async function stageGateway(client: TrueNasClient, gateway: string, staticNetworks: NetworkAddress[]): Promise<void> {
  if (gateway && staticNetworks.some((n) => inSubnet(gateway, n.address, n.prefix))) {
    // Checked against the staged addresses, so a gateway in a brand-new network is accepted too.
    await client.call('interface.save_network_config', [{ ipv4gateway: gateway }]);
  } else {
    await client.call('network.configuration.update', [{ ipv4gateway: gateway }]);
  }
}

function finished(ctx: AppContext): void {
  ctx.bus.changed('system');
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export async function startInterfaceChange(ctx: AppContext, name: string, req: InterfaceChangeRequest): Promise<Task> {
  const state = await readNetwork(ctx.truenas.client());
  assertIdle(ctx, state);
  const plan = planInterfaceChange(state, name, req);
  if (plan.usesApexOs && !req.acknowledgeConnectionRisk) {
    throw new UserError(
      `ApexOs talks to TrueNAS through ${name}. Changing it can interrupt the connection for a moment. Confirm that you understand to continue.`,
      409,
      'CONNECTION_RISK_NOT_ACKNOWLEDGED',
    );
  }
  if (!plan.update) return startGlobalChange(ctx, { nameservers: plan.nameservers, gateway: plan.gateway }, `Changing DNS and gateway`);

  const update = plan.update;
  // Clearing DNS servers or the gateway (back to DHCP) waits until the new setup is confirmed.
  const clearDnsLater = plan.nameservers !== null && plan.nameservers.length === 0;
  const clearGatewayLater = plan.gateway === '';
  const steps: string[] = [STEP.check, STEP.dns, STEP.stage, STEP.apply, STEP.reconnect, STEP.confirm];
  if (clearDnsLater || clearGatewayLater) steps.push(STEP.finish);

  return ctx.tasks.start({ type: TASK_TYPE, title: `Changing the network settings of ${name}`, ref: name, steps }, async (t) => {
    try {
      const saved = await t.step(STEP.check, () => saveCurrent(ctx));
      if (plan.nameservers?.length) {
        await t.step(STEP.dns, () => ctx.truenas.client().call('network.configuration.update', [padNameservers(plan.nameservers!)]).catch((err) => Promise.reject(explain(err))));
      } else t.skip(STEP.dns, clearDnsLater ? 'Switched to automatic after confirming' : 'Unchanged');

      const result = await applyAndConfirm({
        ctx,
        t,
        saved,
        stageStep: STEP.stage,
        stage: async (client) => {
          if (plan.pin) await client.call('interface.update', [plan.pin, { ipv4_dhcp: true }]);
          await client.call('interface.update', [name, update]);
          if (plan.gateway) await stageGateway(client, plan.gateway, plan.staticNetworks);
        },
        verify: async (client) => {
          const now = await readInterface(client, name);
          return !!now && now.ipv4_dhcp === update.ipv4_dhcp && aliasKey(now.aliases) === aliasKey(update.aliases);
        },
        urls: candidateUrls(saved, {
          usesApexOs: plan.usesApexOs,
          localIp: state.localIp,
          newAddress: plan.newAddress,
          hostname: state.config.hostname,
          domain: state.config.domain,
        }),
        where: plan.newAddress ? `at its new address ${plan.newAddress}` : update.ipv4_dhcp && plan.usesApexOs ? 'after it switched to automatic addressing' : 'after the change',
      });
      if (!result.ok) throw new UserError(`Your previous settings were restored because ${result.reason}.`, 409, 'ROLLED_BACK');
      await rememberUrl(ctx, saved, result.url);

      if (clearDnsLater || clearGatewayLater) {
        await t.step(STEP.finish, async () => {
          const change: Record<string, string> = {};
          if (clearDnsLater) Object.assign(change, padNameservers([]));
          if (clearGatewayLater) change.ipv4gateway = '';
          await ctx.truenas.client().call('network.configuration.update', [change]).catch((err) => Promise.reject(explain(err)));
        });
      }
    } finally {
      finished(ctx);
    }
  });
}

/** DNS servers and gateway only. TrueNAS applies these right away; they are not part of its rollback. */
function startGlobalChange(ctx: AppContext, plan: { nameservers: string[] | null; gateway: string | null }, title: string): Task {
  const steps = [STEP.check, STEP.dns, STEP.gateway, STEP.verifyConnection];
  return ctx.tasks.start({ type: TASK_TYPE, title, steps }, async (t) => {
    try {
      const saved = await t.step(STEP.check, () => saveCurrent(ctx));
      if (plan.nameservers) {
        await t.step(STEP.dns, () => ctx.truenas.client().call('network.configuration.update', [padNameservers(plan.nameservers!)]).catch((err) => Promise.reject(explain(err))));
      } else t.skip(STEP.dns, 'Unchanged');
      if (plan.gateway !== null) {
        await t.step(STEP.gateway, () => ctx.truenas.client().call('network.configuration.update', [{ ipv4gateway: plan.gateway }]).catch((err) => Promise.reject(explain(err))));
      } else t.skip(STEP.gateway, 'Unchanged');
      await t.step(STEP.verifyConnection, async () => {
        const url = await reach(ctx, [saved.url], Date.now() + networkTimings.attemptTimeoutMs * 2, () => undefined);
        if (!url) throw new Error('ApexOs lost its connection to TrueNAS after the change. Check the gateway in the TrueNAS web interface.');
      });
    } finally {
      finished(ctx);
    }
  });
}

export async function startDnsChange(ctx: AppContext, req: DnsChangeRequest): Promise<Task> {
  const state = await readNetwork(ctx.truenas.client());
  assertIdle(ctx, state);
  return startGlobalChange(ctx, planDnsChange(state, req), 'Changing DNS and gateway');
}

export async function startVlanCreate(ctx: AppContext, req: VlanCreateRequest): Promise<Task> {
  const state = await readNetwork(ctx.truenas.client());
  assertIdle(ctx, state);
  const plan = planVlan(state, req);
  const title = `Adding VLAN ${req.tag} on ${req.parent}`;
  return ctx.tasks.start({ type: TASK_TYPE, title, ref: plan.name, steps: [STEP.check, STEP.createVlan, STEP.apply, STEP.reconnect, STEP.confirm] }, async (t) => {
    try {
      const saved = await t.step(STEP.check, () => saveCurrent(ctx));
      let name = plan.name;
      const result = await applyAndConfirm({
        ctx,
        t,
        saved,
        stageStep: STEP.createVlan,
        stage: async (client) => {
          if (plan.pin) await client.call('interface.update', [plan.pin, { ipv4_dhcp: true }]);
          name = (await client.call<TnIface>('interface.create', [plan.create])).name;
        },
        verify: async (client) => {
          const now = name ? await readInterface(client, name) : undefined;
          return !!now && !now.fake;
        },
        urls: { during: [saved.url], after: [saved.url] },
        where: 'after the change',
      });
      if (!result.ok) throw new UserError(`Your previous settings were restored because ${result.reason}.`, 409, 'ROLLED_BACK');
    } finally {
      finished(ctx);
    }
  });
}

export async function startVlanDelete(ctx: AppContext, name: string): Promise<Task> {
  const state = await readNetwork(ctx.truenas.client());
  assertIdle(ctx, state);
  planVlanDelete(state, name);
  return ctx.tasks.start({ type: TASK_TYPE, title: `Removing ${name}`, ref: name, steps: [STEP.check, STEP.removeVlan, STEP.apply, STEP.reconnect, STEP.confirm] }, async (t) => {
    try {
      const saved = await t.step(STEP.check, () => saveCurrent(ctx));
      const result = await applyAndConfirm({
        ctx,
        t,
        saved,
        stageStep: STEP.removeVlan,
        stage: async (client) => {
          await client.call('interface.delete', [name]);
        },
        verify: async (client) => !(await readInterface(client, name)),
        urls: { during: [saved.url], after: [saved.url] },
        where: 'after the change',
      });
      if (!result.ok) throw new UserError(`Your previous settings were restored because ${result.reason}.`, 409, 'ROLLED_BACK');
    } finally {
      finished(ctx);
    }
  });
}

/** Drops staged network changes that were never applied (e.g. left in the TrueNAS web interface). */
export async function discardPendingChanges(ctx: AppContext): Promise<void> {
  if (ctx.tasks.findRunning(TASK_TYPE)) throw new UserError('A network change is in progress. Wait for it to finish.', 409, 'BUSY');
  const client = ctx.truenas.client();
  const [waiting, pending] = await Promise.all([
    client.call<number | null>('interface.checkin_waiting'),
    client.call<boolean>('interface.has_pending_changes'),
  ]);
  if (waiting !== null) throw new UserError('TrueNAS is trying out changes right now; they are kept or undone within a minute.', 409, 'BUSY');
  if (!pending) return;
  await client.call('interface.rollback');
  finished(ctx);
}
