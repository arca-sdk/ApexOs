/** IPv4 address arithmetic for validating network settings. */
import { isIP } from 'node:net';

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export function isIPv4(value: string): boolean {
  return IPV4_RE.test(value);
}

export function toInt(address: string): number {
  return address.split('.').reduce((n, octet) => n * 256 + Number(octet), 0);
}

export function fromInt(n: number): string {
  return [24, 16, 8, 0].map((shift) => Math.floor(n / 2 ** shift) % 256).join('.');
}

/** Number of addresses in a network of this prefix length. */
function size(prefix: number): number {
  return 2 ** (32 - prefix);
}

/** First address of the network `address/prefix` (as an integer). */
export function networkStart(address: string, prefix: number): number {
  return Math.floor(toInt(address) / size(prefix)) * size(prefix);
}

export function inSubnet(ip: string, address: string, prefix: number): boolean {
  return isIPv4(ip) && isIPv4(address) && networkStart(ip, prefix) === networkStart(address, prefix);
}

/** Whether two networks share any address. */
export function overlaps(a: string, aPrefix: number, b: string, bPrefix: number): boolean {
  const p = Math.min(aPrefix, bPrefix);
  return networkStart(a, p) === networkStart(b, p);
}

export function cidr(address: string, prefix: number): string {
  return `${fromInt(networkStart(address, prefix))}/${prefix}`;
}

export function prefixToMask(prefix: number): string {
  return fromInt(2 ** 32 - size(prefix));
}

/** Why an address can't be given to a server port, or null when it can. */
export function hostAddressProblem(address: string, prefix: number): string | null {
  if (!isIPv4(address)) return 'Enter an IPv4 address like 192.168.1.50';
  const first = Number(address.split('.')[0]);
  if (first === 0) return 'Addresses starting with 0 can’t be used';
  if (first === 127) return 'That is a loopback address; use one from your home network';
  if (first >= 224) return 'That is a multicast or reserved address; use one from your home network';
  if (address.startsWith('169.254.')) return 'That is a self-assigned (link-local) address; use one from your home network';
  if (prefix <= 30) {
    const start = networkStart(address, prefix);
    if (toInt(address) === start) return `That is the network’s own address; try ${fromInt(start + 1)} or higher`;
    if (toInt(address) === start + size(prefix) - 1) return 'That is the network’s broadcast address; pick a lower number';
  }
  return null;
}

/** Why an address can't be a DNS server (the same rules TrueNAS applies), or null when it can. */
export function nameserverProblem(address: string): string | null {
  const family = isIP(address);
  if (!family) return 'Enter an IP address like 1.1.1.1';
  if (address === '::1' || address.startsWith('127.')) return 'A loopback address can’t be a DNS server';
  if (address === '0.0.0.0' || address === '::') return 'Enter a real DNS server address';
  if (address === '255.255.255.255') return 'Enter a real DNS server address';
  if (address.startsWith('169.254.')) return 'Self-assigned (169.254.x.x) addresses can’t be DNS servers';
  return null;
}
