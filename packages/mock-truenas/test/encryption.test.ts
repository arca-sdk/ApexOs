import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { TrueNasClient } from '@apexos/truenas-client';
import { createPool, failure, setup, type Any } from './helpers.ts';

const hex = () => randomBytes(32).toString('hex');
const GiB = 1024 ** 3;

async function download(client: TrueNasClient, baseUrl: string, method: string, args: unknown[], filename: string): Promise<{ status: number; body: string; jobId: number; disposition: string | null }> {
  const [jobId, url] = await client.call<[number, string]>('core.download', [method, args, filename, true]);
  const res = await fetch(new URL(url, baseUrl));
  return { status: res.status, body: await res.text(), jobId, disposition: res.headers.get('content-disposition') };
}

async function withPool() {
  const ctx = await setup();
  await createPool(ctx.client, 'tank', 'MIRROR', ['sdb', 'sdc']);
  return ctx;
}

describe('dataset encryption', () => {
  it('creates key and passphrase encrypted datasets and reports their state', async () => {
    const { client, mock } = await withPool();
    const key = hex();
    const auto = await client.call<Any>('pool.dataset.create', [
      { name: 'tank/Photos', share_type: 'SMB', encryption: true, inherit_encryption: false, encryption_options: { key } },
    ]);
    expect(auto).toMatchObject({ encrypted: true, encryption_root: 'tank/Photos', key_loaded: true, locked: false });
    expect(auto.key_format).toMatchObject({ value: 'HEX', rawvalue: 'hex' });
    expect(auto.encryption_algorithm.value).toBe('AES-256-GCM');
    expect(mock.state.encryptionKeys!['tank/Photos']).toBe(key);

    const vault = await client.call<Any>('pool.dataset.create', [
      { name: 'tank/Vault', encryption: true, inherit_encryption: false, encryption_options: { passphrase: 'correct horse battery' } },
    ]);
    expect(vault.key_format.value).toBe('PASSPHRASE');
    expect(vault.pbkdf2iters.value).toBe('350000');
    expect(mock.state.encryptionKeys!['tank/Vault']).toBeUndefined();

    const generated = await client.call<Any>('pool.dataset.create', [{ name: 'tank/Gen', encryption: true, inherit_encryption: false, encryption_options: { generate_key: true } }]);
    expect(generated.encryption_root).toBe('tank/Gen');
    expect(mock.state.encryptionKeys!['tank/Gen']).toMatch(/^[0-9a-f]{64}$/);

    // Children inherit; a plain dataset stays unencrypted.
    const child = await client.call<Any>('pool.dataset.create', [{ name: 'tank/Vault/Inner' }]);
    expect(child).toMatchObject({ encrypted: true, encryption_root: 'tank/Vault' });
    expect(child.key_format.value).toBe('PASSPHRASE');
    const plain = await client.call<Any>('pool.dataset.create', [{ name: 'tank/Plain' }]);
    expect(plain).toMatchObject({ encrypted: false, encryption_root: null, locked: false });
    expect(plain.key_format.value).toBeNull();

    // Narrow property lists without a crypto property leave the crypto fields out.
    const [narrow] = await client.call<Any[]>('pool.dataset.query', [[['id', '=', 'tank/Vault']], { extra: { properties: ['used'] } }]);
    expect(narrow.encrypted).toBeUndefined();
    expect(narrow.locked).toBeUndefined();
    const [wide] = await client.call<Any[]>('pool.dataset.query', [[['id', '=', 'tank/Vault']], { extra: { properties: ['used', 'encryption', 'keyformat'] } }]);
    expect(wide).toMatchObject({ encrypted: true, locked: false });
    expect(wide.key_format.value).toBe('PASSPHRASE');
  });

  it('validates encryption options like the middleware', async () => {
    const { client } = await withPool();
    const inherit = await failure(client.call('pool.dataset.create', [{ name: 'tank/A', encryption: true, encryption_options: { generate_key: true } }]));
    expect(inherit.validationErrors['pool_dataset_create.inherit_encryption']).toBe('Must be disabled when encryption is enabled.');
    const both = await failure(
      client.call('pool.dataset.create', [{ name: 'tank/A', encryption: true, inherit_encryption: false, encryption_options: { passphrase: 'abcdefgh', key: hex() } }]),
    );
    expect(both.validationErrors['pool_dataset_create.encryption_options.key']).toMatch(/Must be disabled/);
    const none = await failure(client.call('pool.dataset.create', [{ name: 'tank/A', encryption: true, inherit_encryption: false }]));
    expect(none.validationErrors['pool_dataset_create.encryption_options.key']).toMatch(/Please provide a key/);
    const short = await failure(
      client.call('pool.dataset.create', [{ name: 'tank/A', encryption: true, inherit_encryption: false, encryption_options: { passphrase: 'short' } }]),
    );
    expect(short.validationErrors['pool_dataset_create.encryption_options.passphrase']).toMatch(/at least 8/);

    await client.call('pool.dataset.create', [{ name: 'tank/Vault', encryption: true, inherit_encryption: false, encryption_options: { passphrase: 'abcdefgh' } }]);
    const keyUnderPass = await failure(
      client.call('pool.dataset.create', [{ name: 'tank/Vault/K', encryption: true, inherit_encryption: false, encryption_options: { generate_key: true } }]),
    );
    expect(keyUnderPass.validationErrors['pool_dataset_create.encryption']).toBe('Passphrase encrypted datasets cannot have children encrypted with a key.');
    const unencrypted = await failure(client.call('pool.dataset.create', [{ name: 'tank/Vault/P', encryption: false, inherit_encryption: false }]));
    expect(unencrypted.validationErrors['pool_dataset_create.encryption']).toMatch(/Cannot create an unencrypted dataset within an encrypted dataset \(tank\/Vault\)/);
  });

  it('locks and unlocks passphrase roots; shares, files and apps follow', async () => {
    const { client, mock } = await setup({ scenario: 'configured' });
    await client.call('pool.dataset.create', [
      { name: 'HDDs/Vault', share_type: 'SMB', encryption: true, inherit_encryption: false, encryption_options: { passphrase: 'correct horse battery' } },
    ]);
    await client.call('pool.dataset.create', [{ name: 'HDDs/Auto', encryption: true, inherit_encryption: false, encryption_options: { generate_key: true } }]);
    await client.call('filesystem.mkdir', [{ path: '/mnt/HDDs/Vault/Taxes' }]);
    const share = await client.call<Any>('sharing.smb.create', [{ name: 'Vault', path: '/mnt/HDDs/Vault', purpose: 'DEFAULT_SHARE' }]);
    expect(share.locked).toBe(false);
    // An app with a host path inside the folder.
    const jellyfin = mock.state.apps.find((a) => a.name === 'jellyfin')!;
    (jellyfin.config.storage as Any).additional_storage.push({ type: 'host_path', host_path_config: { path: '/mnt/HDDs/Vault/Taxes' } });

    expect((await failure(client.job('pool.dataset.lock', ['HDDs/Auto']))).message).toMatch(/Only datasets which are encrypted with passphrase can be locked/);
    await client.call('pool.dataset.create', [{ name: 'HDDs/Vault/Child' }]);
    expect((await failure(client.job('pool.dataset.lock', ['HDDs/Vault/Child']))).message).toMatch(/Please lock HDDs\/Vault\. Only encryption roots can be locked/);

    expect(await client.job('pool.dataset.lock', ['HDDs/Vault'])).toBe(true);
    const [locked] = await client.call<Any[]>('pool.dataset.query', [[['id', '=', 'HDDs/Vault']]]);
    expect(locked).toMatchObject({ locked: true, key_loaded: false });
    expect((await client.call<Any[]>('pool.dataset.query', [[['id', '=', 'HDDs/Vault/Child']]]))[0].locked).toBe(true);
    expect((await client.call<Any[]>('sharing.smb.query', [[['name', '=', 'Vault']]]))[0].locked).toBe(true);
    expect(await client.call('filesystem.listdir', ['/mnt/HDDs/Vault'])).toEqual([]);
    expect((await failure(client.call('filesystem.stat', ['/mnt/HDDs/Vault/Taxes']))).errname).toBe('ENOENT');
    const acl = await failure(client.job('filesystem.setacl', [{ path: '/mnt/HDDs/Vault', dacl: [] }]));
    expect(acl.message).toMatch(/currently encrypted and locked/);
    expect(mock.state.apps.find((a) => a.name === 'jellyfin')!.state).toBe('STOPPED');
    expect((await failure(client.job('pool.dataset.lock', ['HDDs/Vault']))).message).toMatch(/already locked/);

    const summary = await client.job<Any[]>('pool.dataset.encryption_summary', ['HDDs/Vault', { datasets: [{ name: 'HDDs/Vault', passphrase: 'wrong passphrase' }] }]);
    expect(summary).toEqual([
      expect.objectContaining({ name: 'HDDs/Vault', key_format: 'PASSPHRASE', valid_key: false, locked: true, unlock_successful: false, unlock_error: 'Provided key is invalid' }),
    ]);
    const wrong = await client.job<Any>('pool.dataset.unlock', ['HDDs/Vault', { datasets: [{ name: 'HDDs/Vault', passphrase: 'wrong passphrase' }] }]);
    expect(wrong).toEqual({ unlocked: [], failed: { 'HDDs/Vault': { error: 'Invalid Key', skipped: [] } } });
    const missing = await failure(client.job('pool.dataset.unlock', ['HDDs/Vault', {}]));
    expect(missing.validationErrors['unlock_options.datasets']).toBe('Please specify key for HDDs/Vault');

    const right = await client.job<Any>('pool.dataset.unlock', ['HDDs/Vault', { datasets: [{ name: 'HDDs/Vault', passphrase: 'correct horse battery' }] }]);
    expect(right).toEqual({ unlocked: ['HDDs/Vault'], failed: {} });
    expect((await client.call<Any[]>('sharing.smb.query', [[['name', '=', 'Vault']]]))[0].locked).toBe(false);
    expect((await client.call<Any[]>('filesystem.listdir', ['/mnt/HDDs/Vault'])).map((e) => e.name)).toEqual(['Child', 'Taxes']);
    // Apps are not started again by an unlock.
    expect(mock.state.apps.find((a) => a.name === 'jellyfin')!.state).toBe('STOPPED');
    // The passphrase is never stored.
    expect(mock.state.encryptionKeys!['HDDs/Vault']).toBeUndefined();
    const notLocked = await failure(client.job('pool.dataset.unlock', ['HDDs/Vault', { datasets: [{ name: 'HDDs/Vault', passphrase: 'x' }] }]));
    expect(notLocked.validationErrors.id).toBe('HDDs/Vault dataset is not locked');
  });

  it('changes key format both ways and keeps the key store in sync', async () => {
    const { client, mock } = await withPool();
    const key = hex();
    await client.call('pool.dataset.create', [{ name: 'tank/Docs', encryption: true, inherit_encryption: false, encryption_options: { key } }]);
    await client.job('pool.dataset.change_key', ['tank/Docs', { passphrase: 'a long passphrase' }]);
    let [ds] = await client.call<Any[]>('pool.dataset.query', [[['id', '=', 'tank/Docs']]]);
    expect(ds.key_format.value).toBe('PASSPHRASE');
    expect(mock.state.encryptionKeys!['tank/Docs']).toBeUndefined();

    const both = await failure(client.job('pool.dataset.change_key', ['tank/Docs', { passphrase: 'another one!', generate_key: true }]));
    expect(both.validationErrors['change_key_options.key']).toMatch(/Must not be specified/);
    const nothing = await failure(client.job('pool.dataset.change_key', ['tank/Docs', {}]));
    expect(nothing.validationErrors['change_key_options.key']).toBe('Either Key or passphrase must be provided.');

    await client.job('pool.dataset.change_key', ['tank/Docs', { generate_key: true }]);
    [ds] = await client.call<Any[]>('pool.dataset.query', [[['id', '=', 'tank/Docs']]]);
    expect(ds.key_format.value).toBe('HEX');
    const stored = mock.state.encryptionKeys!['tank/Docs']!;
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).not.toBe(key);
    expect(await client.job('pool.dataset.export_key', ['tank/Docs'])).toBe(stored);

    await client.job('pool.dataset.change_key', ['tank/Docs', { passphrase: 'a long passphrase' }]);
    await client.job('pool.dataset.lock', ['tank/Docs']);
    const lockedChange = await failure(client.job('pool.dataset.change_key', ['tank/Docs', { generate_key: true }]));
    expect(lockedChange.validationErrors.id).toBe('Dataset must be unlocked before key can be changed');
  });

  it('exports keys only through core.download', async () => {
    const { client, mock } = await withPool();
    const k1 = hex();
    const k2 = hex();
    await client.call('pool.dataset.create', [{ name: 'tank/A', encryption: true, inherit_encryption: false, encryption_options: { key: k1 } }]);
    await client.call('pool.dataset.create', [{ name: 'tank/B', encryption: true, inherit_encryption: false, encryption_options: { key: k2 } }]);
    await client.call('pool.dataset.create', [{ name: 'tank/P', encryption: true, inherit_encryption: false, encryption_options: { passphrase: 'abcdefgh' } }]);

    const direct = await failure(client.job('pool.dataset.export_keys', ['tank']));
    expect(direct.message).toMatch(/Pipe 'output' is not open/);
    const res = await download(client, mock.baseUrl, 'pool.dataset.export_keys', ['tank'], 'tank-keys.json');
    expect(res.status).toBe(200);
    expect(res.disposition).toBe('attachment; filename="tank-keys.json"');
    expect(JSON.parse(res.body)).toEqual({ 'tank/A': k1, 'tank/B': k2 });
    expect(res.body).toContain('": "'); // Python json.dumps separators
    expect((await client.waitForJob(res.jobId)).state).toBe('SUCCESS');

    const one = await download(client, mock.baseUrl, 'pool.dataset.export_key', ['tank/A', true], 'a.json');
    expect(JSON.parse(one.body)).toEqual({ 'tank/A': k1 });
    const pass = await failure(client.job('pool.dataset.export_key', ['tank/P']));
    expect(pass.message).toMatch(/does not have it's own encryption key/);
    const notDownloadable = await failure(client.call('core.download', ['pool.dataset.query', [], 'x.json', true]));
    expect(notDownloadable.message).toMatch(/does not produce a download/);

    // Tokens are single-use.
    const [, url] = await client.call<[number, string]>('core.download', ['pool.dataset.export_keys', ['tank'], 'k.json', true]);
    expect((await fetch(new URL(url, mock.baseUrl))).status).toBe(200);
    expect((await fetch(new URL(url, mock.baseUrl))).status).toBe(401);
  });

  it('renames datasets without moving stored keys; change_key re-registers the key under the new name', async () => {
    const { client, mock } = await withPool();
    const key = hex();
    await client.call('pool.dataset.create', [{ name: 'tank/Copy', encryption: true, inherit_encryption: false, encryption_options: { key } }]);
    await client.call('filesystem.mkdir', [{ path: '/mnt/tank/Copy/inner' }]);
    await client.call('pool.snapshot.create', [{ dataset: 'tank/Copy', name: 'snap1' }]);

    const noForce = await failure(client.call('pool.dataset.rename', ['tank/Copy', { new_name: 'tank/Photos' }]));
    expect(noForce.validationErrors['pool.dataset.rename.force']).toMatch(/No safety checks/);
    expect(await client.call('pool.dataset.rename', ['tank/Copy', { new_name: 'tank/Photos', force: true }])).toBeNull();
    const [renamed] = await client.call<Any[]>('pool.dataset.query', [[['id', '=', 'tank/Photos']]]);
    expect(renamed).toMatchObject({ encryption_root: 'tank/Photos', mountpoint: '/mnt/tank/Photos', locked: false });
    expect((await client.call<Any[]>('pool.snapshot.query', [[['dataset', '=', 'tank/Photos']]])).map((s) => s.snapshot_name)).toEqual(['snap1']);
    expect((await client.call<Any[]>('filesystem.listdir', ['/mnt/tank/Photos'])).map((e) => e.name)).toEqual(['inner']);
    expect(Object.keys(mock.state.encryptionKeys!)).toEqual(['tank/Copy']);

    // Without re-registering, the folder stays locked after a reboot.
    await client.job('system.reboot', ['test']);
    expect((await client.call<Any[]>('pool.dataset.query', [[['id', '=', 'tank/Photos']]]))[0].locked).toBe(true);
    await client.job('pool.dataset.unlock', ['tank/Photos', { datasets: [{ name: 'tank/Photos', key }] }]);
    // A key supplied at unlock is stored under the dataset's current name.
    expect(mock.state.encryptionKeys!['tank/Photos']).toBe(key);
    await client.job('system.reboot', ['test']);
    expect((await client.call<Any[]>('pool.dataset.query', [[['id', '=', 'tank/Photos']]]))[0].locked).toBe(false);
    // The stale record goes away on the next key sync (export_keys runs one).
    await download(client, mock.baseUrl, 'pool.dataset.export_keys', ['tank'], 'k.json');
    expect(Object.keys(mock.state.encryptionKeys!)).toEqual(['tank/Photos']);

    await client.call('pool.dataset.create', [{ name: 'tank/Other' }]);
    const exists = await failure(client.call('pool.dataset.rename', ['tank/Photos', { new_name: 'tank/Other', force: true }]));
    expect(exists.message).toMatch(/cannot rename to 'tank\/Other': dataset already exists/);
    const outside = await failure(client.call('pool.dataset.rename', ['tank/Photos', { new_name: 'other/Photos', force: true }]));
    expect(outside.message).toMatch(/datasets must be within same pool/);
  });

  it('keeps passphrase folders locked after a reboot and forgets keys on pool export', async () => {
    const { client, mock } = await withPool();
    await client.call('pool.dataset.create', [{ name: 'tank/Vault', encryption: true, inherit_encryption: false, encryption_options: { passphrase: 'abcdefgh' } }]);
    await client.call('pool.dataset.create', [{ name: 'tank/Auto', encryption: true, inherit_encryption: false, encryption_options: { generate_key: true } }]);
    await client.job('system.reboot', ['test']);
    const state = async () =>
      Object.fromEntries((await client.call<Any[]>('pool.dataset.query', [[['encrypted', '=', true]]])).map((d) => [d.id, d.locked]));
    expect(await state()).toEqual({ 'tank/Auto': false, 'tank/Vault': true });

    const [pool] = await client.call<Any[]>('pool.query', [[['name', '=', 'tank']]]);
    await client.job('pool.export', [pool.id]);
    expect(mock.state.encryptionKeys).toEqual({});
    const [found] = await client.job<Any[]>('pool.import_find');
    const tank = (await client.job<Any[]>('pool.import_find')).find((p) => p.name === 'tank') ?? found;
    await client.job('pool.import_pool', [{ guid: tank.guid }]);
    expect(await state()).toEqual({ 'tank/Auto': true, 'tank/Vault': true });
  });
});

describe('LOCAL replication.run_onetime', () => {
  const onetime = (extra: Record<string, unknown> = {}) => ({
    direction: 'PUSH',
    transport: 'LOCAL',
    source_datasets: ['HDDs/Photos'],
    target_dataset: 'HDDs/.apexos-enc-Photos',
    recursive: true,
    properties: true,
    properties_override: { quota: 'none', refquota: 'none' },
    name_regex: '.*',
    retention_policy: 'NONE',
    readonly: 'IGNORE',
    allow_from_scratch: false,
    only_from_scratch: true,
    mount: true,
    encryption: true,
    encryption_inherit: false,
    encryption_key_format: 'HEX',
    encryption_key: 'a'.repeat(64),
    encryption_key_location: '$TrueNAS',
    ...extra,
  });

  it('copies a dataset tree into a new encryption root, then sends incrementals', async () => {
    const { client, mock } = await setup({ scenario: 'configured' });
    await client.call('pool.dataset.update', ['HDDs/Photos', { quota: 600 * GiB }]);
    await client.call('pool.dataset.create', [{ name: 'HDDs/Photos/Raw', share_type: 'SMB' }]);
    await client.call('pool.snapshot.create', [{ dataset: 'HDDs/Photos', name: 'apexos-enc-1', recursive: true }]);
    const before = (await client.call<Any[]>('pool.dataset.query', [[['id', '=', 'HDDs/Photos']]]))[0];

    await client.job('replication.run_onetime', [onetime()]);
    const [copy] = await client.call<Any[]>('pool.dataset.query', [[['id', '=', 'HDDs/.apexos-enc-Photos']]]);
    expect(copy).toMatchObject({ encrypted: true, encryption_root: 'HDDs/.apexos-enc-Photos', locked: false });
    expect(copy.key_format.value).toBe('HEX');
    expect(copy.quota.parsed).toBeNull();
    expect(copy.readonly.value).toBe('OFF');
    expect(copy.casesensitivity.value).toBe('INSENSITIVE');
    expect(copy.user_properties).toEqual(before.user_properties);
    expect(copy.used.parsed).toBeGreaterThan(before.used.parsed);
    const [raw] = await client.call<Any[]>('pool.dataset.query', [[['id', '=', 'HDDs/.apexos-enc-Photos/Raw']]]);
    expect(raw).toMatchObject({ encrypted: true, encryption_root: 'HDDs/.apexos-enc-Photos' });
    expect(mock.state.encryptionKeys!['HDDs/.apexos-enc-Photos']).toBe('a'.repeat(64));
    expect(mock.state.datasets.find((d) => d.id === 'HDDs/.apexos-enc-Photos')!.encryption!.keylocation).toMatch(/^file:\/\/\/tmp\/zettarepl-key-/);
    const names = (await client.call<Any[]>('filesystem.listdir', ['/mnt/HDDs/.apexos-enc-Photos'])).map((e) => e.name);
    expect(names).toEqual(['2024', '2025', '2026', 'IMG_4821.HEIC', 'Raw']);
    const acl = await client.call<Any>('filesystem.getacl', ['/mnt/HDDs/.apexos-enc-Photos']);
    expect(acl.acl).toEqual((await client.call<Any>('filesystem.getacl', ['/mnt/HDDs/Photos'])).acl);
    expect((await client.call<Any[]>('pool.snapshot.query', [[['dataset', '=', 'HDDs/.apexos-enc-Photos/Raw']]])).map((s) => s.snapshot_name)).toEqual(['apexos-enc-1']);

    // Running it again from scratch is refused; an incremental run sends only the new snapshot.
    const again = await failure(client.job('replication.run_onetime', [onetime()]));
    expect(again.message).toMatch(/Target dataset 'HDDs\/\.apexos-enc-Photos' already exists/);
    await client.call('filesystem.mkdir', [{ path: '/mnt/HDDs/Photos/2027' }]);
    await client.call('pool.snapshot.create', [{ dataset: 'HDDs/Photos', name: 'apexos-enc-2', recursive: true }]);
    await client.job('replication.run_onetime', [onetime({ only_from_scratch: false })]);
    expect((await client.call<Any[]>('pool.snapshot.query', [[['dataset', '=', 'HDDs/.apexos-enc-Photos']]])).map((s) => s.snapshot_name)).toEqual(['apexos-enc-1', 'apexos-enc-2']);
    expect((await client.call<Any[]>('filesystem.listdir', ['/mnt/HDDs/.apexos-enc-Photos'])).map((e) => e.name)).toContain('2027');
  });

  it('validates arguments and refuses what zettarepl refuses', async () => {
    const { client } = await setup({ scenario: 'configured' });
    const missing = await failure(client.call('replication.run_onetime', [{ direction: 'PUSH', transport: 'LOCAL' }]));
    expect(missing.validationErrors['replication_run_onetime.source_datasets']).toBe('Field required');
    const noKey = await failure(client.job('replication.run_onetime', [onetime({ encryption_key: null })]));
    expect(noKey.validationErrors['replication_run_onetime.encryption_key']).toMatch(/required when remote dataset encryption is enabled/);
    const noSnaps = await failure(client.job('replication.run_onetime', [onetime()]));
    expect(noSnaps.message).toMatch(/does not have any matching snapshots/);
    const ssh = await failure(client.call('replication.run_onetime', [onetime({ transport: 'SSH', ssh_credentials: 1 })]));
    expect(ssh.message).toMatch(/not simulated/);

    await client.call('pool.dataset.create', [{ name: 'HDDs/Secret', encryption: true, inherit_encryption: false, encryption_options: { generate_key: true } }]);
    await client.call('pool.snapshot.create', [{ dataset: 'HDDs/Secret', name: 's1' }]);
    const reencrypt = await failure(client.job('replication.run_onetime', [onetime({ source_datasets: ['HDDs/Secret'], target_dataset: 'HDDs/Secret2' })]));
    expect(reencrypt.message).toMatch(/Re-encrypting already encrypted source dataset 'HDDs\/Secret'/);

    // readonly defaults to SET
    await client.call('pool.snapshot.create', [{ dataset: 'HDDs/Documents', name: 's1' }]);
    await client.job('replication.run_onetime', [onetime({ source_datasets: ['HDDs/Documents'], target_dataset: 'HDDs/DocsCopy', readonly: undefined, encryption: false })]);
    expect((await client.call<Any[]>('pool.dataset.query', [[['id', '=', 'HDDs/DocsCopy']]]))[0].readonly.value).toBe('ON');
  });
});
