import { request } from 'node:https';
import { request as httpRequest } from 'node:http';
import { TrueNasConnectionError } from './client.ts';

/** ApexOs is written against the TrueNAS 25.10 API (`v25.10.0` and its compatible updates `v25.10.N`). */
export const API_FAMILY = 'v25.10';

/** Fetches `GET /api/versions` (no auth needed) from a TrueNAS host. */
export function fetchApiVersions(baseUrl: string, timeoutMs = 10_000): Promise<string[]> {
  const url = new URL('/api/versions', baseUrl);
  const doRequest = url.protocol === 'https:' ? request : httpRequest;
  return new Promise((resolve, reject) => {
    const req = doRequest(url, { method: 'GET', rejectUnauthorized: false, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new TrueNasConnectionError(`${url.host} answered ${res.statusCode} — is this a TrueNAS SCALE 25.10 server?`));
          return;
        }
        try {
          const parsed = JSON.parse(body);
          if (!Array.isArray(parsed)) throw new Error('not a list');
          resolve(parsed.map(String));
        } catch {
          reject(new TrueNasConnectionError(`${url.host} did not return a TrueNAS API version list`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (err) => reject(new TrueNasConnectionError(`Cannot reach ${url.host}: ${err.message}`)));
    req.end();
  });
}

/**
 * The newest 25.10 API version a server offers, or null when it has none.
 *
 * TrueNAS answers only its newest API version directly; requests on older versions go through a
 * converter that, on 25.10.7, fails for some replies with "Object of type _NotRequired is not JSON
 * serializable" (`interface.query`, `network.configuration.config` and `.update`). Within 25.10 newer
 * versions only add compatible changes, so the newest one is both safe and unconverted on 25.10.x.
 */
export function pickApiVersion(versions: string[]): string | null {
  return versions.filter((v) => /^v\d+\.\d+\.\d+$/.test(v) && v.startsWith(`${API_FAMILY}.`)).sort(compareApiVersions).at(-1) ?? null;
}

/** The HTTP(S) base URL (`https://host:port`) of a TrueNAS API websocket URL. */
export function apiBaseUrl(apiUrl: string): string {
  const url = new URL(apiUrl);
  const protocol = url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : url.protocol;
  return `${protocol}//${url.host}`;
}

/** Picks the websocket URL to use for a host (see `pickApiVersion`); fails for releases older than 25.10. */
export async function resolveApiUrl(baseUrl: string): Promise<string> {
  const versions = await fetchApiVersions(baseUrl);
  const base = new URL(baseUrl);
  const wsProtocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  const version = pickApiVersion(versions);
  if (version) return `${wsProtocol}//${base.host}/api/${version}`;
  const newest = versions.filter((v) => /^v\d+\.\d+/.test(v)).sort(compareApiVersions).at(-1) ?? 'unknown';
  throw new TrueNasConnectionError(
    `This TrueNAS release (newest API ${newest}) is not supported. ApexOs needs TrueNAS SCALE 25.10 or newer.`,
  );
}

function compareApiVersions(a: string, b: string): number {
  const pa = a.slice(1).split('.').map(Number);
  const pb = b.slice(1).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}
