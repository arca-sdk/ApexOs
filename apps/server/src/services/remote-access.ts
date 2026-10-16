/**
 * Remote access through services the user owns, installed as TrueNAS catalog apps:
 *
 * - Tailscale (`community/tailscale`): the server joins the user's tailnet with host networking, so
 *   ApexOs, file shares and the TrueNAS UI are reachable from the user's devices. Optionally the home
 *   network is advertised as a subnet route (needs approval in the Tailscale admin console).
 * - Cloudflare Tunnel (`community/cloudflared`): publishes the ApexOs web UI through a hostname the
 *   user set up in their Cloudflare account. Web only; requires two-factor sign-in.
 *
 * ApexOs never stores auth keys or tunnel tokens: they go into the app's TrueNAS configuration and
 * are deleted with the app on Turn off.
 */
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { CloudflareStatus, RemoteAccessStatus, RemoteAppState, SecurityCheckItem, TailscaleStatus } from '@apexos/api-types';
import type { TrueNasClient } from '@apexos/truenas-client';
import type { AppContext } from '../app.ts';
import { UserError } from '../lib/errors.ts';
import type { RemoteAccessState } from '../lib/store.ts';
import type { Task, TaskContext } from '../lib/tasks.ts';
import type { TnApp } from '../truenas/types.ts';
import { appState, createCatalogApp, deleteApp, getEngine, uniqueAppName } from './apps.ts';
import { assertAppsNotMoving } from './apps-pool.ts';
import { lanIp } from './system.ts';
import { getAccountSecurity } from './two-factor.ts';

/** Both apps live in the community train; `app.create` would otherwise look in `stable`. */
const TRAIN = 'community';
const TAILSCALE = { catalogApp: 'tailscale', title: 'Tailscale' } as const;
const CLOUDFLARE = { catalogApp: 'cloudflared', title: 'Cloudflare Tunnel' } as const;
const IP_FORWARD = 'net.ipv4.ip_forward';

type TailscaleRecord = NonNullable<RemoteAccessState['tailscale']>;
type IpForwardingRecord = NonNullable<TailscaleRecord['ipForwarding']>;

interface TnTunable {
  id: number;
  var: string;
  value: string;
  enabled: boolean;
}

interface SchemaQuestion {
  variable: string;
  schema?: { attrs?: SchemaQuestion[] };
}

interface TnAppDetails {
  latest_version: string;
  versions: Record<string, { schema?: { questions?: SchemaQuestion[] } }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isCatalogApp(app: TnApp, catalogApp: string): boolean {
  return !app.custom_app && app.metadata?.name === catalogApp;
}

/** 100.64.0.0/10 (Tailscale's CGNAT range) or its IPv6 ULA prefix fd7a:115c:a1e0::/48. */
export function isTailnetAddress(address: string): boolean {
  const v4 = address.replace(/^::ffff:/i, '');
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(v4);
  if (m) return Number(m[1]) === 100 && Number(m[2]) >= 64 && Number(m[2]) <= 127;
  return address.toLowerCase().startsWith('fd7a:115c:a1e0:');
}

function connectedVia(req: FastifyRequest): RemoteAccessStatus['connectedVia'] {
  if (req.headers['cf-connecting-ip'] || req.headers['cf-ray']) return 'cloudflare';
  if (isTailnetAddress(req.ip)) return 'tailscale';
  if (req.headers['x-forwarded-for']) return 'proxy';
  return 'direct';
}

function splitHost(host: string | undefined): { name: string; port: number | null } {
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(host ?? '');
  return m ? { name: m[1]!.toLowerCase(), port: m[2] ? Number(m[2]) : null } : { name: '', port: null };
}

/**
 * The port ApexOs is reached on at home: the one in the address bar when that is a LAN or tailnet
 * address (correct behind Docker port mapping), otherwise the port the server listens on.
 */
function publicPort(req: FastifyRequest): number {
  const { name, port } = splitHost(req.headers.host);
  const local = /^\d{1,3}(\.\d{1,3}){3}$/.test(name) ? !name.startsWith('127.') : !name.includes('.') || /\.(local|lan|home\.arpa|ts\.net)$/.test(name);
  if (port && local && name !== 'localhost') return port;
  return req.socket.localPort ?? 8080;
}

/** `192.168.1.20/24` → `192.168.1.0/24` (null for anything that isn't a sensible IPv4 LAN). */
export function networkOf(cidr: string): string | null {
  const [address, bitsText] = cidr.split('/');
  const bits = Number(bitsText);
  const octets = (address ?? '').split('.').map(Number);
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255) || !Number.isInteger(bits) || bits < 8 || bits > 30) return null;
  const n = octets.reduce((acc, o) => acc * 256 + o, 0);
  const net = n - (n % 2 ** (32 - bits));
  return `${[24, 16, 8, 0].map((s) => Math.floor(net / 2 ** s) % 256).join('.')}/${bits}`;
}

/** The subnet of the interface holding the LAN address, e.g. 192.168.1.0/24. */
async function homeNetwork(client: TrueNasClient, ip: string | null): Promise<string | null> {
  if (!ip) return null;
  const summary = await client.call<{ ips: Record<string, { IPV4?: string[] }> }>('network.general.summary').catch(() => null);
  const cidr = Object.values(summary?.ips ?? {})
    .flatMap((i) => i.IPV4 ?? [])
    .find((c) => c.split('/')[0] === ip);
  return cidr ? networkOf(cidr) : null;
}

function schemaHas(questions: SchemaQuestion[], path: string): boolean {
  let level = questions;
  const parts = path.split('.');
  for (const [i, part] of parts.entries()) {
    const q = level.find((x) => x.variable === part);
    if (!q) return false;
    if (i < parts.length - 1) level = q.schema?.attrs ?? [];
  }
  return true;
}

/** Re-reads the app's install schema from the TrueNAS catalog and checks the settings ApexOs fills in still exist. */
async function checkCatalogSchema(client: TrueNasClient, catalogApp: string, title: string, paths: string[]): Promise<void> {
  const details = await client.call<TnAppDetails>('catalog.get_app_details', [catalogApp, { train: TRAIN }]).catch((err: Error) => {
    throw new UserError(`The ${title} app isn’t available in the TrueNAS catalog (${err.message}). Check Apps → Discover → Manage catalog.`, 409, 'NOT_IN_CATALOG');
  });
  const questions = details.versions?.[details.latest_version]?.schema?.questions ?? [];
  const missing = paths.filter((p) => !schemaHas(questions, p));
  if (missing.length) {
    throw new UserError(`The ${title} app in the TrueNAS catalog changed in a way ApexOs doesn’t understand yet (${missing.join(', ')}).`, 409, 'SCHEMA_CHANGED');
  }
}

async function requireAppsReady(client: TrueNasClient): Promise<void> {
  const engine = await getEngine(client);
  if (!engine.pool) throw new UserError('Remote access runs as an app, and apps need a storage pool. Finish setting up storage first.', 409, 'NO_APPS_POOL');
  if (engine.status !== 'RUNNING') throw new UserError('The apps service isn’t running right now. Check the Apps page, then try again.', 409, 'APPS_NOT_RUNNING');
}

async function findApps(client: TrueNasClient, catalogApp: string): Promise<TnApp[]> {
  const apps = await client.call<TnApp[]>('app.query').catch(() => [] as TnApp[]);
  return apps.filter((a) => isCatalogApp(a, catalogApp));
}

/** Waits for the app to report RUNNING; gives up quietly after a while (the status page shows the state). */
async function waitForRunning(client: TrueNasClient, name: string, title: string, hint: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [app] = await client.call<TnApp[]>('app.query', [[['name', '=', name]]]);
    if (!app || app.state === 'RUNNING') return;
    if (app.state === 'CRASHED') throw new UserError(`${title} didn’t start. ${hint}`, 502, 'APP_CRASHED');
    if (Date.now() > deadline) return;
    await sleep(2_000);
  }
}

function startExclusive(ctx: AppContext, opts: { type: string; title: string; ref: string; steps: string[] }, fn: (task: TaskContext) => Promise<void>): Task {
  if (ctx.tasks.findRunning('remote-enable') || ctx.tasks.findRunning('remote-disable')) {
    throw new UserError('Remote access is already being changed. Wait for that to finish.', 409, 'BUSY');
  }
  assertAppsNotMoving(ctx);
  return ctx.tasks.start(opts, fn);
}

// ---------------------------------------------------------------------------
// IP forwarding (Tailscale subnet routes)
// ---------------------------------------------------------------------------

/** Makes IPv4 forwarding explicit and persistent with a sysctl tunable; returns what to undo later (null = nothing). */
async function ensureIpForwarding(client: TrueNasClient): Promise<IpForwardingRecord | null> {
  const [existing] = await client.call<TnTunable[]>('tunable.query', [[['var', '=', IP_FORWARD]]]);
  if (!existing) {
    const created = await client.job<TnTunable>('tunable.create', [
      { type: 'SYSCTL', var: IP_FORWARD, value: '1', comment: 'ApexOs: lets Tailscale share the home network', enabled: true },
    ]);
    return { tunableId: created.id, created: true, previous: null };
  }
  if (existing.value === '1' && existing.enabled) return null;
  await client.job('tunable.update', [existing.id, { value: '1', enabled: true }]);
  return { tunableId: existing.id, created: false, previous: { value: existing.value, enabled: existing.enabled } };
}

async function undoIpForwarding(client: TrueNasClient, rec: IpForwardingRecord): Promise<void> {
  const [current] = await client.call<TnTunable[]>('tunable.query', [[['id', '=', rec.tunableId]]]);
  if (!current) return;
  if (rec.created) await client.job('tunable.delete', [rec.tunableId]);
  else if (rec.previous) await client.job('tunable.update', [rec.tunableId, rec.previous]);
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function checklist(ctx: AppContext, req: FastifyRequest): SecurityCheckItem[] {
  const security = getAccountSecurity(ctx, req);
  const exposed = Boolean(ctx.store.get().remoteAccess.cloudflare);
  return [
    {
      id: 'two-factor',
      ok: security.twoFactor.enabled,
      title: 'Two-factor sign-in',
      detail: security.twoFactor.enabled
        ? 'On. Signing in needs a code from your authenticator app.'
        : 'Off. Turn it on in Settings → Your account before you reach ApexOs from outside your home.',
    },
    {
      id: 'password',
      ok: security.strongPassword,
      title: 'Strong password',
      detail:
        security.strongPassword === true
          ? 'Your password is long and varied.'
          : security.strongPassword === false
            ? 'Your password is short or simple. Change it to a long passphrase (16 characters or more).'
            : 'ApexOs can’t tell how strong your password is. If it’s short, change it to a long passphrase.',
    },
    {
      id: 'secure-cookies',
      ok: security.secureCookies ? true : exposed ? false : null,
      title: 'Secure cookies',
      detail: security.secureCookies
        ? 'On. Your sign-in cookie is only ever sent over HTTPS.'
        : 'When ApexOs is reached over HTTPS (Cloudflare Tunnel or your own HTTPS proxy), start it with APEXOS_SECURE_COOKIES=1 so the sign-in cookie never travels unencrypted. Then always use the HTTPS address, also at home. Not needed for Tailscale, which encrypts everything itself.',
    },
  ];
}

/** Remembers the tailnet address and name the user used to reach ApexOs, since TrueNAS doesn't report them. */
async function rememberTailnetAddress(ctx: AppContext, req: FastifyRequest): Promise<void> {
  const rec = ctx.store.get().remoteAccess.tailscale;
  if (!rec || !isTailnetAddress(req.ip)) return;
  const { name } = splitHost(req.headers.host);
  const ip = /^\d{1,3}(\.\d{1,3}){3}$/.test(name) && isTailnetAddress(name) ? name : null;
  const fqdn = /^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(name) ? name : null;
  if ((!ip || ip === rec.tailnetIp) && (!fqdn || fqdn === rec.tailnetName)) return;
  await ctx.store.update((s) => {
    if (!s.remoteAccess.tailscale) return;
    if (ip) s.remoteAccess.tailscale.tailnetIp = ip;
    if (fqdn) s.remoteAccess.tailscale.tailnetName = fqdn;
  });
}

async function appConfig(client: TrueNasClient, name: string): Promise<Record<string, unknown> | null> {
  return client.call<Record<string, unknown>>('app.config', [name]).catch(() => null);
}

function remoteState(rec: unknown, app: TnApp | undefined): RemoteAppState | null {
  if (app) return appState(app.state);
  return rec ? 'missing' : null;
}

export function suggestedHostname(ctx: AppContext): string {
  const name = (ctx.store.get().server.name ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
  return name || 'apexos';
}

export async function getRemoteStatus(ctx: AppContext, req: FastifyRequest): Promise<RemoteAccessStatus> {
  const client = ctx.truenas.client();
  await rememberTailnetAddress(ctx, req);
  const [engine, apps, ip] = await Promise.all([getEngine(client), client.call<TnApp[]>('app.query').catch(() => [] as TnApp[]), lanIp(client)]);
  const state = ctx.store.get();
  const port = publicPort(req);
  const appsReady = Boolean(engine.pool) && engine.status === 'RUNNING';

  // Tailscale
  const tsRec = state.remoteAccess.tailscale;
  const tsApps = apps.filter((a) => isCatalogApp(a, TAILSCALE.catalogApp));
  const tsApp = tsRec ? tsApps.find((a) => a.name === tsRec.appName) : undefined;
  const tsExternal = tsApps.find((a) => a.name !== tsRec?.appName);
  const tsShown = tsApp ?? (tsRec ? undefined : tsExternal);
  const [tsConfig, home] = await Promise.all([tsShown ? appConfig(client, tsShown.name) : null, homeNetwork(client, ip)]);
  const tsValues = (tsConfig?.tailscale ?? {}) as { hostname?: string; advertise_routes?: string[]; extra_args?: string[] };
  const hostname = tsValues.hostname ?? tsRec?.hostname ?? null;
  const loginServer = tsValues.extra_args?.find((a) => a.startsWith('--login-server='))?.slice('--login-server='.length);
  const tailscale: TailscaleStatus = {
    enabled: Boolean(tsRec),
    external: !tsRec && Boolean(tsExternal),
    appName: tsShown?.name ?? tsRec?.appName ?? null,
    state: remoteState(tsRec, tsShown),
    hostname,
    suggestedHostname: suggestedHostname(ctx),
    routes: tsValues.advertise_routes ?? tsRec?.routes ?? [],
    homeNetwork: home,
    controlServer: loginServer ?? tsRec?.controlServer ?? null,
    tailnetIp: tsRec?.tailnetIp ?? null,
    tailnetName: tsRec?.tailnetName ?? null,
    remoteUrl: hostname ? `http://${hostname}:${port}` : null,
    filesAddress: hostname ? `\\\\${hostname}` : null,
    appVersion: tsShown?.metadata?.app_version ?? null,
    enabledAt: tsRec?.enabledAt ?? null,
  };

  // Cloudflare Tunnel
  const cfRec = state.remoteAccess.cloudflare;
  const cfApps = apps.filter((a) => isCatalogApp(a, CLOUDFLARE.catalogApp));
  const cfApp = cfRec ? cfApps.find((a) => a.name === cfRec.appName) : undefined;
  const cfExternal = cfApps.find((a) => a.name !== cfRec?.appName);
  const cfShown = cfApp ?? (cfRec ? undefined : cfExternal);
  const cloudflare: CloudflareStatus = {
    enabled: Boolean(cfRec),
    external: !cfRec && Boolean(cfExternal),
    appName: cfShown?.name ?? cfRec?.appName ?? null,
    state: remoteState(cfRec, cfShown),
    publicHostname: cfRec?.publicHostname ?? null,
    serviceUrl: ip ? `http://${ip}:${port}` : null,
    appVersion: cfShown?.metadata?.app_version ?? null,
    enabledAt: cfRec?.enabledAt ?? null,
  };

  return {
    localUrl: ip ? `http://${ip}:${port}` : null,
    lanIp: ip,
    port,
    connectedVia: connectedVia(req),
    appsReady,
    appsMessage: appsReady
      ? null
      : engine.pool
        ? 'The apps service isn’t running right now, so remote access can’t be changed. Check the Apps page.'
        : 'Remote access runs as an app, and apps need a storage pool. Finish setting up storage first.',
    twoFactorEnabled: Boolean(state.security.twoFactor),
    checklist: checklist(ctx, req),
    tailscale,
    cloudflare,
  };
}

// ---------------------------------------------------------------------------
// Tailscale
// ---------------------------------------------------------------------------

const hostnameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/, 'Use lowercase letters, numbers and dashes (not at the start or end), up to 63 characters');

const tailscaleSchema = z.object({
  authKey: z.string().trim().min(1, 'Paste an auth key').max(512, 'That key is too long'),
  hostname: hostnameSchema,
  shareHomeNetwork: z.boolean().default(false),
  controlServer: z
    .string()
    .trim()
    .max(512)
    .nullish()
    .transform((v) => v || null)
    .refine((v) => v === null || /^https:\/\/[^\s/?#]+(\/[^\s?#]*)?$/.test(v), 'Use the https:// address of your Headscale server'),
  acceptWithoutTwoFactor: z.boolean().optional(),
});

export async function startTailscale(ctx: AppContext, input: unknown): Promise<Task> {
  const body = tailscaleSchema.parse(input);
  const state = ctx.store.get();
  if (/\s/.test(body.authKey)) throw new UserError('An auth key has no spaces.', 400, 'VALIDATION', { authKey: 'An auth key has no spaces' });
  if (!body.controlServer && !body.authKey.startsWith('tskey-')) {
    throw new UserError('Tailscale auth keys start with “tskey-”.', 400, 'VALIDATION', { authKey: 'Tailscale auth keys start with “tskey-”' });
  }
  if (!state.security.twoFactor && !body.acceptWithoutTwoFactor) {
    throw new UserError('Turn on two-factor sign-in first, or confirm that you want to continue without it.', 409, 'TWO_FACTOR_RECOMMENDED');
  }
  if (state.remoteAccess.tailscale) throw new UserError('Tailscale is already on. Turn it off first to change its settings.', 409, 'ALREADY_ON');
  const client = ctx.truenas.client();
  await requireAppsReady(client);
  const existing = await findApps(client, TAILSCALE.catalogApp);
  if (existing.length) {
    throw new UserError(
      `Tailscale is already installed on this server as the app “${existing[0]!.name}”. Keep using it, or remove it on the Apps page and set it up here.`,
      409,
      'ALREADY_INSTALLED',
    );
  }
  const home = body.shareHomeNetwork ? await homeNetwork(client, await lanIp(client)) : null;
  if (body.shareHomeNetwork && !home) {
    throw new UserError('ApexOs couldn’t work out your home network’s address range, so it can’t be shared.', 409, 'NO_HOME_NETWORK');
  }
  const routes = home ? [home] : [];
  const steps = ['Checking the Tailscale app', ...(routes.length ? ['Turning on traffic forwarding'] : []), 'Installing Tailscale', 'Starting Tailscale'];

  return startExclusive(ctx, { type: 'remote-enable', title: 'Turning on Tailscale', ref: TAILSCALE.title, steps }, async (task) => {
    await task.step('Checking the Tailscale app', () =>
      checkCatalogSchema(client, TAILSCALE.catalogApp, TAILSCALE.title, [
        'tailscale.hostname',
        'tailscale.auth_key',
        'tailscale.auth_once',
        'tailscale.userspace',
        'tailscale.accept_dns',
        'tailscale.advertise_routes',
        'tailscale.extra_args',
        'network.host_network',
      ]),
    );
    const ipForwarding = routes.length ? await task.step('Turning on traffic forwarding', () => ensureIpForwarding(client)) : null;
    const name = await uniqueAppName(client, TAILSCALE.catalogApp);
    const values = {
      tailscale: {
        hostname: body.hostname,
        auth_key: body.authKey,
        // Log in with the key once; the node identity then lives in the app's state volume.
        auth_once: true,
        // Kernel networking, so the server itself (ApexOs, shares, TrueNAS UI) is on the tailnet.
        userspace: false,
        // Keep the server's own DNS settings.
        accept_dns: false,
        advertise_routes: routes,
        extra_args: body.controlServer ? [`--login-server=${body.controlServer}`] : [],
      },
      network: { host_network: true },
    };
    try {
      await createCatalogApp(ctx, task, 'Installing Tailscale', { name, catalogApp: TAILSCALE.catalogApp, train: TRAIN, values });
    } catch (err) {
      if (ipForwarding) await undoIpForwarding(client, ipForwarding).catch(() => undefined);
      throw err;
    }
    await ctx.store.update((s) => {
      s.remoteAccess.tailscale = {
        appName: name,
        hostname: body.hostname,
        routes,
        controlServer: body.controlServer,
        ipForwarding,
        tailnetIp: null,
        tailnetName: null,
        enabledAt: new Date().toISOString(),
      };
    });
    await task.step('Starting Tailscale', () =>
      waitForRunning(client, name, TAILSCALE.title, 'Check that the auth key is valid and hasn’t expired, then turn Tailscale off and try again with a new key.'),
    );
    ctx.bus.changed('apps');
  });
}

export async function stopTailscale(ctx: AppContext): Promise<Task> {
  const rec = ctx.store.get().remoteAccess.tailscale;
  if (!rec) throw new UserError('Tailscale isn’t on.', 409, 'NOT_ON');
  const steps = ['Removing Tailscale', ...(rec.ipForwarding ? ['Turning off traffic forwarding'] : [])];
  return startExclusive(ctx, { type: 'remote-disable', title: 'Turning off Tailscale', ref: TAILSCALE.title, steps }, async (task) => {
    const client = ctx.truenas.client();
    const [app] = await client.call<TnApp[]>('app.query', [[['name', '=', rec.appName]]]);
    // The state volume (the server's Tailscale identity) and the app configuration (with the auth key) go too.
    if (app) await deleteApp(ctx, task, 'Removing Tailscale', rec.appName, true);
    else task.skip('Removing Tailscale', 'It was already removed');
    if (rec.ipForwarding) await task.step('Turning off traffic forwarding', () => undoIpForwarding(client, rec.ipForwarding!));
    await ctx.store.update((s) => {
      s.remoteAccess.tailscale = null;
    });
    ctx.bus.changed('apps');
  });
}

// ---------------------------------------------------------------------------
// Cloudflare Tunnel
// ---------------------------------------------------------------------------

/**
 * Accepts the bare token or the whole install command Cloudflare shows
 * (`cloudflared service install <token>`, `… tunnel run --token <token>`) and checks its shape:
 * base64 of a JSON object with the account tag `a`, tunnel id `t` and secret `s`.
 */
export function parseTunnelToken(input: string): string | null {
  const token = input.trim().split(/\s+/).at(-1) ?? '';
  if (!/^[A-Za-z0-9+/_-]{40,4096}={0,2}$/.test(token)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf8')) as Record<string, unknown>;
    return ['a', 't', 's'].every((k) => typeof decoded[k] === 'string' && decoded[k]) ? token : null;
  } catch {
    return null;
  }
}

const cloudflareSchema = z.object({
  token: z.string().min(1, 'Paste the tunnel token').max(8192),
  publicHostname: z
    .string()
    .trim()
    .toLowerCase()
    .max(300)
    .nullish()
    .transform((v) => (v ? v.replace(/^https?:\/\//, '').replace(/[/?#].*$/, '') : null))
    .refine((v) => v === null || /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(v), 'Enter a hostname like nas.example.com'),
});

export async function startCloudflare(ctx: AppContext, input: unknown): Promise<Task> {
  const body = cloudflareSchema.parse(input);
  const token = parseTunnelToken(body.token);
  if (!token) {
    throw new UserError('That doesn’t look like a tunnel token.', 400, 'VALIDATION', {
      token: 'Copy the long token (it starts with “eyJ”) from your tunnel’s install command in Cloudflare',
    });
  }
  const state = ctx.store.get();
  if (!state.security.twoFactor) {
    throw new UserError('Cloudflare Tunnel puts your sign-in page on the internet. Turn on two-factor sign-in first.', 409, 'TWO_FACTOR_REQUIRED');
  }
  if (state.remoteAccess.cloudflare) throw new UserError('Cloudflare Tunnel is already on. Turn it off first to change it.', 409, 'ALREADY_ON');
  const client = ctx.truenas.client();
  await requireAppsReady(client);
  const existing = await findApps(client, CLOUDFLARE.catalogApp);
  if (existing.length) {
    throw new UserError(
      `Cloudflare Tunnel is already installed on this server as the app “${existing[0]!.name}”. Keep using it, or remove it on the Apps page and set it up here.`,
      409,
      'ALREADY_INSTALLED',
    );
  }
  const steps = ['Checking the Cloudflare Tunnel app', 'Installing Cloudflare Tunnel', 'Starting Cloudflare Tunnel'];
  return startExclusive(ctx, { type: 'remote-enable', title: 'Turning on Cloudflare Tunnel', ref: CLOUDFLARE.title, steps }, async (task) => {
    await task.step('Checking the Cloudflare Tunnel app', () =>
      checkCatalogSchema(client, CLOUDFLARE.catalogApp, CLOUDFLARE.title, ['cloudflared.tunnel_token', 'network.host_network']),
    );
    const name = await uniqueAppName(client, CLOUDFLARE.catalogApp);
    const values = {
      cloudflared: { tunnel_token: token },
      // The catalog default; the tunnel reaches ApexOs at the server's LAN address.
      network: { host_network: false },
    };
    await createCatalogApp(ctx, task, 'Installing Cloudflare Tunnel', { name, catalogApp: CLOUDFLARE.catalogApp, train: TRAIN, values });
    await ctx.store.update((s) => {
      s.remoteAccess.cloudflare = { appName: name, publicHostname: body.publicHostname, enabledAt: new Date().toISOString() };
    });
    await task.step('Starting Cloudflare Tunnel', () =>
      waitForRunning(client, name, CLOUDFLARE.title, 'Check that the token belongs to an active tunnel, then turn Cloudflare Tunnel off and try again.'),
    );
    ctx.bus.changed('apps');
  });
}

export async function stopCloudflare(ctx: AppContext): Promise<Task> {
  const rec = ctx.store.get().remoteAccess.cloudflare;
  if (!rec) throw new UserError('Cloudflare Tunnel isn’t on.', 409, 'NOT_ON');
  return startExclusive(ctx, { type: 'remote-disable', title: 'Turning off Cloudflare Tunnel', ref: CLOUDFLARE.title, steps: ['Removing Cloudflare Tunnel'] }, async (task) => {
    const client = ctx.truenas.client();
    const [app] = await client.call<TnApp[]>('app.query', [[['name', '=', rec.appName]]]);
    if (app) await deleteApp(ctx, task, 'Removing Cloudflare Tunnel', rec.appName, true);
    else task.skip('Removing Cloudflare Tunnel', 'It was already removed');
    await ctx.store.update((s) => {
      s.remoteAccess.cloudflare = null;
    });
    ctx.bus.changed('apps');
  });
}
