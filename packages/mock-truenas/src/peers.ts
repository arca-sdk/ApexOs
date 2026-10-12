/**
 * Simulated network between simulators running in the same process.
 *
 * Every started simulator registers here with its SSH identity: the address it listens on plus its
 * `ssh.config` port. Replication over SSH and `keychaincredential.remote_ssh_host_key_scan` look the
 * other box up by `host:port`, so two simulators can move data between each other. Several simulators
 * usually share 127.0.0.1, so each one gets a distinct SSH port (22 for the first, then 2222, 2223, …).
 * A closed simulator disappears from the registry, which looks like a server that is switched off.
 */
import type { Mock } from './context.ts';
import { CallError } from './rpc.ts';
import type { KeychainCredentialState, UserState } from './state.ts';

interface Peer {
  mock: Mock;
  /** Address the simulator's API listens on (e.g. 127.0.0.1). */
  host: string;
}

const peers = new Set<Peer>();
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const FIRST_EXTRA_PORT = 2222;

function sameHost(a: string, b: string): boolean {
  return a === b || (LOOPBACK.has(a) && LOOPBACK.has(b));
}

/** Names and addresses that reach a simulator: its listen address, hostname and LAN address. */
function addressesOf(p: Peer): string[] {
  const net = p.mock.state.network;
  const out = [p.host, net.hostname, `${net.hostname}.${net.domain}`, p.mock.lanIp];
  if (LOOPBACK.has(p.host)) out.push(...LOOPBACK);
  return out.map((a) => a.toLowerCase());
}

/**
 * Adds a simulator to the registry. Without an explicit `sshPort`, the saved `ssh.config` port is kept
 * unless another running simulator on the same address already uses it.
 */
export function registerPeer(mock: Mock, host: string, sshPort?: number): void {
  const taken = (port: number) => [...peers].some((p) => p.mock !== mock && !p.mock.closed && sameHost(p.host, host) && p.mock.state.ssh.tcpport === port);
  if (sshPort !== undefined) mock.state.ssh.tcpport = sshPort;
  else if (taken(mock.state.ssh.tcpport)) {
    let port = FIRST_EXTRA_PORT;
    while (taken(port)) port++;
    mock.state.ssh.tcpport = port;
  }
  peers.add({ mock, host });
}

export function unregisterPeer(mock: Mock): void {
  for (const p of peers) if (p.mock === mock) peers.delete(p);
}

/** The running simulator reachable at `host:port`, if any. */
export function findPeer(host: string, port: number): Mock | undefined {
  const wanted = host.trim().toLowerCase();
  for (const p of peers) {
    if (p.mock.closed || p.mock.state.ssh.tcpport !== port) continue;
    if (addressesOf(p).includes(wanted)) return p.mock;
  }
  return undefined;
}

/** `ssh` connection failure as zettarepl/paramiko reports it. */
export function connectionRefused(host: string, port: number): CallError {
  return new CallError('EFAULT', `[Errno 111] Unable to connect to port ${port} on ${host}: Connection refused`, null, 111);
}

/** Public key (type + base64 blob) of each line, ignoring options and comments. */
export function keyIds(text: string | null | undefined): string[] {
  const out: string[] = [];
  for (const line of (text ?? '').split('\n')) {
    const parts = line.trim().split(/\s+/);
    const i = parts.findIndex((p) => /^(ssh-|ecdsa-|sk-)/.test(p));
    if (i >= 0 && parts[i + 1]) out.push(`${parts[i]} ${parts[i + 1]}`);
  }
  return out;
}

/** Host key lines (`<type> <base64>`) a simulator presents, as `ssh-keyscan` prints them without hostnames. */
export function hostKeyLines(mock: Mock): string[] {
  const k = mock.state.ssh.hostKeys;
  return [k.rsa, k.ecdsa, k.ed25519];
}

export interface SshSession {
  peer: Mock;
  user: UserState;
  /** The remote user may run `zfs` with full rights (root, or passwordless sudo for zfs when `sudo` is set). */
  privileged: boolean;
}

function sudoAllowsZfs(peer: Mock, user: UserState): boolean {
  const ok = (cmds: string[]) => cmds.some((c) => c === 'ALL' || c === '/usr/sbin/zfs');
  if (ok(user.sudo_commands_nopasswd)) return true;
  return [user.group, ...user.groups].some((gid) => {
    const g = peer.state.groups.find((x) => x.id === gid);
    return g ? ok(g.sudo_commands_nopasswd) : false;
  });
}

/**
 * Opens a simulated SSH session with an `SSH_CREDENTIALS` keychain entry of `from`, with the checks a
 * real connection makes: the server is up and SSH is running, the pinned host key matches, the user
 * exists and accepts the key pair, has a login shell, and (with `sudo`) may run zfs without a password.
 */
export function openSsh(from: Mock, credential: KeychainCredentialState, opts: { sudo: boolean }): SshSession {
  const a = credential.attributes;
  const host = String(a.host ?? '');
  const port = Number(a.port ?? 22);
  const peer = findPeer(host, port);
  const ssh = peer?.state.services.find((s) => s.service === 'ssh');
  if (!peer || ssh?.state !== 'RUNNING') throw connectionRefused(host, port);

  const pinned = keyIds(String(a.remote_host_key ?? ''));
  const offered = keyIds(hostKeyLines(peer).join('\n'));
  if (!offered.some((k) => pinned.includes(k))) {
    throw new CallError(
      'EFAULT',
      `Host key for server '${host}' does not match: got '${offered.at(-1)?.split(' ')[1] ?? ''}', expected '${pinned[0]?.split(' ')[1] ?? ''}'`,
    );
  }

  const pair = from.state.keychain.find((k) => k.id === a.private_key && k.type === 'SSH_KEY_PAIR');
  const publicKey = keyIds(String(pair?.attributes.public_key ?? ''))[0];
  const username = String(a.username ?? 'root');
  const user = peer.state.users.find((u) => u.username === username);
  if (!user || user.locked || !publicKey || !keyIds(user.sshpubkey).includes(publicKey)) {
    throw new CallError('EFAULT', 'Authentication failed.');
  }
  if (/nologin|false$/.test(user.shell)) throw new CallError('EFAULT', 'This account is currently not available.');
  if (opts.sudo && user.uid !== 0 && !sudoAllowsZfs(peer, user)) {
    throw new CallError('EFAULT', 'Passwordless `sudo` for `/usr/sbin/zfs` is not set up correctly on the remote system.');
  }
  return { peer, user, privileged: user.uid === 0 || (opts.sudo && sudoAllowsZfs(peer, user)) };
}
