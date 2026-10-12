import { request } from 'node:https';
import { request as httpRequest } from 'node:http';
import { TrueNasConnectionError } from './client.ts';

/** API version ApexOs is written against; it exists on every 25.10.x release and on 26.x. */
export const PREFERRED_API_VERSION = 'v25.10.0';

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
 * Picks the websocket URL to use for a host. Prefers the pinned API version so behaviour does not
 * change silently when TrueNAS is upgraded; fails for releases older than 25.10.
 */
export async function resolveApiUrl(baseUrl: string): Promise<string> {
  const versions = await fetchApiVersions(baseUrl);
  const base = new URL(baseUrl);
  const wsProtocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  if (versions.includes(PREFERRED_API_VERSION)) {
    return `${wsProtocol}//${base.host}/api/${PREFERRED_API_VERSION}`;
  }
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
