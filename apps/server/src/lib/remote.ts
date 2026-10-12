/**
 * Talking to another TrueNAS server (a backup destination) through its own API, separately from the
 * single connection to this server's TrueNAS (lib/truenas.ts).
 *
 * The same transport rules apply: HTTPS/WSS only, because TrueNAS revokes API keys that are sent over
 * plain HTTP. The one exception is a server on this very computer (loopback), which is how the
 * simulated servers of demo mode and the tests are reached; `assertSecureTransport` enforces that.
 */
import { TrueNasClient, TrueNasConnectionError, TrueNasError, type TrueNasAuth } from '@apexos/truenas-client';
import { UserError } from './errors.ts';
import { createApiKeyWithPassword, resolveApiUrl } from './truenas.ts';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Raised when the other server can't be reached; the message is safe to show. */
export class PeerUnreachableError extends UserError {
  constructor(message: string) {
    super(message, 409, 'DESTINATION_UNREACHABLE');
    this.name = 'PeerUnreachableError';
  }
}

/** Normalizes what the user typed (`nas2.lan`, `100.64.1.7`, `https://nas2.lan:8443/ui`) into a base URL. */
export function peerBaseUrl(address: string): string {
  let input = address.trim();
  if (!input) throw new UserError('Enter the address of the other server.', 400, 'VALIDATION', { address: 'Required' });
  if (!/^[a-z]+:\/\//i.test(input)) input = `https://${input}`;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UserError('That doesn’t look like a server address.', 400, 'VALIDATION', { address: 'Enter an IP address or a name' });
  }
  if (url.protocol === 'wss:') url.protocol = 'https:';
  if (url.protocol === 'ws:') url.protocol = 'http:';
  const local = LOOPBACK.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new UserError('Use an https:// address, or just the IP address or name. TrueNAS only accepts sign-ins over an encrypted connection.', 400, 'VALIDATION', {
      address: 'Use https',
    });
  }
  return `${url.protocol}//${url.host}`;
}

/** Host name or IP in a base URL (what the SSH connection uses). */
export function hostOf(baseUrl: string): string {
  return new URL(baseUrl).hostname.replace(/^\[|\]$/g, '');
}

function unreachable(name: string, err: unknown): PeerUnreachableError {
  const detail = err instanceof Error ? err.message : String(err);
  return new PeerUnreachableError(
    `Couldn’t reach ${name}. Check that it’s turned on and on the same network as this server (or connected through your VPN). (${detail})`,
  );
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new TrueNasConnectionError(message)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/** Resolves the versioned API URL (refuses TrueNAS releases older than 25.10). */
export async function resolvePeerApi(baseUrl: string, name = hostOf(baseUrl)): Promise<string> {
  try {
    return await withTimeout(resolveApiUrl(baseUrl), 12_000, 'timed out');
  } catch (err) {
    if (err instanceof TrueNasConnectionError && /not supported/.test(err.message)) throw new UserError(err.message, 400, 'UNSUPPORTED_VERSION');
    throw unreachable(name, err);
  }
}

/** Opens a connection; wrong credentials become a UserError, network problems a PeerUnreachableError. */
export async function openPeer(apiUrl: string, auth: TrueNasAuth, opts: { name?: string; timeoutMs?: number } = {}): Promise<TrueNasClient> {
  const name = opts.name ?? new URL(apiUrl).hostname;
  const client = new TrueNasClient({ url: apiUrl, auth, reconnect: false, pingIntervalMs: 0, callTimeoutMs: 120_000 });
  try {
    await withTimeout(client.connect(), opts.timeoutMs ?? 15_000, 'timed out');
    return client;
  } catch (err) {
    await client.close().catch(() => undefined);
    if (err instanceof TrueNasError && !(err instanceof TrueNasConnectionError)) {
      if (err.errname === 'EOTP') throw new UserError('That account uses two-factor sign-in. Create an API key on the other server and use that instead.', 400, 'OTP_REQUIRED');
      throw new UserError(
        auth.type === 'password' ? 'The other server didn’t accept that username and password.' : 'The other server didn’t accept that API key. It may have been deleted or revoked.',
        400,
        'INVALID_CREDENTIALS',
      );
    }
    throw unreachable(name, err);
  }
}

/** Runs `fn` with a short-lived connection to a destination and always closes it. */
export async function withPeer<T>(
  target: { apiUrl: string; apiKey: string; name: string },
  fn: (client: TrueNasClient) => Promise<T>,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  const client = await openPeer(target.apiUrl, { type: 'apiKey', apiKey: target.apiKey }, { name: target.name, timeoutMs: opts.timeoutMs });
  try {
    return await fn(client);
  } catch (err) {
    if (err instanceof TrueNasConnectionError) throw unreachable(target.name, err);
    throw err;
  } finally {
    await client.close().catch(() => undefined);
  }
}

/**
 * Creates ApexOs's own API key on the other server with the admin password (which is not kept).
 * TrueNAS API keys look like `<id>-<secret>`, so the id is returned too (to delete the key later).
 */
export async function createPeerApiKey(apiUrl: string, username: string, password: string, name: string): Promise<{ key: string; id: number | null }> {
  // Checks the password first so a wrong one gets a clear message.
  const probe = await openPeer(apiUrl, { type: 'password', username, password }, { name });
  await probe.close().catch(() => undefined);
  try {
    const key = await createApiKeyWithPassword(apiUrl, username, password);
    const id = Number.parseInt(key.split('-')[0] ?? '', 10);
    return { key, id: Number.isFinite(id) ? id : null };
  } catch (err) {
    if (err instanceof TrueNasConnectionError) throw unreachable(name, err);
    if (err instanceof TrueNasError) throw new UserError(`The other server didn’t let ApexOs create its key: ${err.reason ?? err.message}`, 400, 'API_KEY_FAILED');
    throw err;
  }
}
