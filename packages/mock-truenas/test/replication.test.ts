import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { TrueNasClient } from '@apexos/truenas-client';
import { newEncryption } from '../src/encryption.ts';
import { startMockTrueNas, type MockTrueNas } from '../src/index.ts';
import { connect, failure, setup, startMock, type Any } from './helpers.ts';

const GiB = 1024 ** 3;
const dir = mkdtempSync(join(tmpdir(), 'mock-replication-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface Pair {
  a: MockTrueNas;
  b: MockTrueNas;
  ca: TrueNasClient;
  cb: TrueNasClient;
  credId: number;
  keyId: number;
}

/** Two configured boxes; B has a receiving user with sudo for zfs and SSH running; A has key pair + credentials. */
async function pair(opts: { sudo?: boolean; shell?: string; stateFile?: string; port?: number } = {}): Promise<Pair> {
  const { mock: a, client: ca } = await setup({ scenario: 'configured' });
  const b = await startMock({ scenario: 'configured', hostname: 'backup-nas', lanIp: '192.168.1.21', stateFile: opts.stateFile, port: opts.port });
  const cb = connect(b);
  await cb.connect();
  const keys = await ca.call<Any>('keychaincredential.generate_ssh_key_pair');
  const kp = await ca.call<Any>('keychaincredential.create', [{ name: 'to-b-key', type: 'SSH_KEY_PAIR', attributes: { private_key: keys.private_key } }]);
  expect(kp.attributes.public_key.split(' ').slice(0, 2)).toEqual(keys.public_key.split(' ').slice(0, 2));
  await cb.call('pool.dataset.create', [{ name: 'HDDs/apexos-backups', share_type: 'GENERIC' }]);
  await cb.call('pool.dataset.create', [{ name: 'HDDs/apexos-backups/truenas', quota: 1024 * GiB, reservation: 1024 * GiB }]);
  await cb.call('user.create', [
    {
      username: 'apexosbk_truenas',
      full_name: 'Backups from truenas',
      group_create: true,
      password_disabled: true,
      smb: false,
      shell: opts.shell ?? '/usr/bin/bash',
      home: '/mnt/HDDs/apexos-backups/truenas',
      home_create: true,
      sshpubkey: keys.public_key,
      sudo_commands_nopasswd: opts.sudo === false ? [] : ['/usr/sbin/zfs'],
    },
  ]);
  await cb.call('service.update', ['ssh', { enable: true }]);
  await cb.job('service.control', ['START', 'ssh', {}]);
  const sshB = await cb.call<Any>('ssh.config');
  const hostKey = await ca.call<string>('keychaincredential.remote_ssh_host_key_scan', [{ host: '127.0.0.1', port: sshB.tcpport }]);
  expect(hostKey).toContain(Buffer.from(sshB.host_ed25519_key_pub, 'base64').toString().split(' ').slice(0, 2).join(' '));
  const cred = await ca.call<Any>('keychaincredential.create', [
    {
      name: 'to-b',
      type: 'SSH_CREDENTIALS',
      attributes: { host: '127.0.0.1', port: sshB.tcpport, username: 'apexosbk_truenas', private_key: kp.id, remote_host_key: hostKey, connect_timeout: 10 },
    },
  ]);
  return { a, b, ca, cb, credId: cred.id, keyId: kp.id };
}

async function pushTask(p: Pair, folder: string, extra: Record<string, unknown> = {}): Promise<{ task: Any; repl: Any }> {
  const task = await p.ca.call<Any>('pool.snapshottask.create', [
    {
      dataset: `HDDs/${folder}`,
      recursive: true,
      naming_schema: 'apexosbk-b-%Y%m%d-%H%M%S',
      lifetime_value: 14,
      lifetime_unit: 'DAY',
      allow_empty: false,
      schedule: { minute: '30', hour: '2', dom: '*', month: '*', dow: '*' },
    },
  ]);
  const repl = await p.ca.call<Any>('replication.create', [
    {
      name: `apexos:b:${folder}`,
      direction: 'PUSH',
      transport: 'SSH',
      ssh_credentials: p.credId,
      sudo: true,
      source_datasets: [`HDDs/${folder}`],
      target_dataset: `HDDs/apexos-backups/truenas/${folder}`,
      recursive: true,
      periodic_snapshot_tasks: [task.id],
      auto: true,
      properties: true,
      retention_policy: 'SOURCE',
      readonly: 'SET',
      hold_pending_snapshots: true,
      compression: 'LZ4',
      speed_limit: 12_500_000,
      ...extra,
    },
  ]);
  return { task, repl };
}

describe('keychain and ssh', () => {
  it('derives public keys, validates credentials and deletes with cascade rules', async () => {
    const { client } = await setup();
    const pair = await client.call<Any>('keychaincredential.generate_ssh_key_pair');
    expect(pair.private_key).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----/);
    expect(pair.public_key).toMatch(/^ssh-rsa AAAA/);
    const bad = await failure(client.call('keychaincredential.create', [{ name: 'x', type: 'SSH_KEY_PAIR', attributes: { private_key: 'nope' } }]));
    expect(bad.validationErrors['keychain_credential_create.attributes.private_key']).toBeDefined();
    const kp = await client.call<Any>('keychaincredential.create', [{ name: 'k', type: 'SSH_KEY_PAIR', attributes: { private_key: pair.private_key } }]);
    const cred = await client.call<Any>('keychaincredential.create', [
      { name: 'c', type: 'SSH_CREDENTIALS', attributes: { host: 'nas2', username: 'bk', private_key: kp.id, remote_host_key: 'ssh-ed25519 AAAA' } },
    ]);
    expect(cred.attributes).toMatchObject({ port: 22, connect_timeout: 10, username: 'bk' });
    expect(await client.call('keychaincredential.used_by', [kp.id])).toEqual([{ title: 'SSH credentials c', unbind_method: 'delete' }]);
    const refused = await failure(client.call('keychaincredential.delete', [kp.id]));
    expect(refused.message).toMatch(/no cascade option/);
    await client.call('keychaincredential.delete', [kp.id, { cascade: true }]);
    expect(await client.call('keychaincredential.query')).toEqual([]);
  });

  it('gives each simulator its own SSH identity and refuses host key scans when SSH is off', async () => {
    const { client: ca } = await setup();
    const b = await startMock({ hostname: 'other' });
    const portA = (await ca.call<Any>('ssh.config')).tcpport;
    expect(b.sshAddress.port).not.toBe(portA);
    const err = await failure(ca.call('keychaincredential.remote_ssh_host_key_scan', [{ host: '127.0.0.1', port: b.sshAddress.port }]));
    expect(err.message).toMatch(/ssh-keyscan failed.*Connection refused/);
    const cb = connect(b);
    await cb.call('service.update', ['ssh', { enable: true }]);
    await cb.job('service.control', ['START', 'ssh', {}]);
    const keys = await ca.call<string>('keychaincredential.remote_ssh_host_key_scan', [{ host: '127.0.0.1', port: b.sshAddress.port }]);
    expect(keys.split('\n').map((l) => l.split(' ')[0])).toEqual(['ssh-rsa', 'ecdsa-sha2-nistp256', 'ssh-ed25519']);
    const updated = await cb.call<Any>('ssh.update', [{ passwordauth: false, tcpport: 2299 }]);
    expect(updated.tcpport).toBe(2299);
    expect(b.sshAddress.port).toBe(2299);
  });
});

describe('periodic snapshot tasks', () => {
  it('validates, snapshots on run, skips empty snapshots and prunes by lifetime', async () => {
    const { mock, client } = await setup({ scenario: 'configured' });
    const err = await failure(client.call('pool.snapshottask.create', [{ dataset: 'HDDs/Photos', naming_schema: 'bad-%Y' }]));
    expect(err.validationErrors['periodic_snapshot_create.naming_schema']).toMatch(/%Y, %m, %d, %H and %M/);
    const t = await client.call<Any>('pool.snapshottask.create', [
      { dataset: 'HDDs/Photos', recursive: true, naming_schema: 'auto-%Y%m%d-%H%M%S', lifetime_value: 2, lifetime_unit: 'DAY', allow_empty: false, schedule: { minute: '0', hour: '3' } },
    ]);
    expect(t).toMatchObject({ state: { state: 'PENDING' }, schedule: { minute: '0', hour: '3', dom: '*', month: '*', dow: '*', begin: '00:00', end: '23:59' } });
    const old = Date.now() - 3 * 86400_000;
    await mock.runSnapshotTask(t.id, old);
    await mock.runSnapshotTask(t.id, old + 60_000); // nothing changed: skipped
    expect(mock.state.snapshots.filter((s) => s.dataset === 'HDDs/Photos')).toHaveLength(1);
    mock.state.datasets.find((d) => d.id === 'HDDs/Photos')!.usedBytes += GiB;
    await mock.runSnapshotTask(t.id);
    // The 3-day-old snapshot is past its 2-day lifetime and nothing holds it.
    const names = mock.state.snapshots.filter((s) => s.dataset === 'HDDs/Photos').map((s) => s.createdAt > old + 1000);
    expect(names).toEqual([true]);
    expect((await client.call<Any>('pool.snapshottask.get_instance', [t.id])).state.state).toBe('FINISHED');
  });
});

describe('replication between two simulators', () => {
  it('pushes a folder over SSH: full, then incremental; copy is read-only and mirrors retention', async () => {
    const p = await pair();
    const { task, repl } = await pushTask(p, 'Photos');
    expect(repl).toMatchObject({ state: { state: 'PENDING' }, ssh_credentials: { id: p.credId, type: 'SSH_CREDENTIALS' }, speed_limit: 12_500_000 });
    expect(repl.periodic_snapshot_tasks[0]).toMatchObject({ id: task.id, naming_schema: 'apexosbk-b-%Y%m%d-%H%M%S' });
    await p.ca.call('pool.snapshot.create', [{ dataset: 'HDDs/Photos', naming_schema: 'apexosbk-b-%Y%m%d-%H%M%S', recursive: true }]);
    const progress: number[] = [];
    await p.ca.job('replication.run', [repl.id], (j) => progress.push(j.progress.percent ?? 0));
    expect(progress.length).toBeGreaterThan(3);
    const copy = await p.cb.call<Any>('pool.dataset.get_instance', ['HDDs/apexos-backups/truenas/Photos']);
    expect(copy.readonly.parsed).toBe(true);
    expect(copy.used.parsed).toBeGreaterThan(400 * GiB);
    expect(copy.user_properties).toEqual({});
    expect(copy.encrypted).toBe(false);
    const state1 = (await p.ca.call<Any>('replication.get_instance', [repl.id])).state;
    expect(state1).toMatchObject({ state: 'FINISHED' });
    expect(state1.last_snapshot).toMatch(/^HDDs\/apexos-backups\/truenas\/Photos@apexosbk-b-/);
    // Files travel with the stream.
    expect(p.b.state.fs.nodes.some((n) => n.path === '/mnt/HDDs/apexos-backups/truenas/Photos/IMG_4821.HEIC')).toBe(true);

    // Incremental: a second snapshot; B keeps both; then retention mirrors A's deletion.
    p.a.state.datasets.find((d) => d.id === 'HDDs/Photos')!.usedBytes += 2 * GiB;
    await new Promise((r) => setTimeout(r, 1100));
    await p.ca.call('pool.snapshot.create', [{ dataset: 'HDDs/Photos', naming_schema: 'apexosbk-b-%Y%m%d-%H%M%S', recursive: true }]);
    await p.ca.job('replication.run', [repl.id]);
    const onB = () => p.b.state.snapshots.filter((s) => s.dataset === 'HDDs/apexos-backups/truenas/Photos').map((s) => s.name);
    expect(onB()).toHaveLength(2);
    const first = p.a.state.snapshots.find((s) => s.dataset === 'HDDs/Photos')!;
    await p.ca.call('pool.snapshot.delete', [first.id]);
    await new Promise((r) => setTimeout(r, 1100));
    await p.ca.call('pool.snapshot.create', [{ dataset: 'HDDs/Photos', naming_schema: 'apexosbk-b-%Y%m%d-%H%M%S', recursive: true }]);
    await p.ca.job('replication.run', [repl.id]);
    expect(onB()).not.toContain(first.name);
    expect(onB()).toHaveLength(2);
  });

  it('starts bound auto replications after a scheduled snapshot', async () => {
    const p = await pair();
    const { task, repl } = await pushTask(p, 'Documents');
    await p.a.runSnapshotTask(task.id);
    const deadline = Date.now() + 3000;
    while ((await p.ca.call<Any>('replication.get_instance', [repl.id])).state.state !== 'FINISHED') {
      if (Date.now() > deadline) throw new Error('auto replication did not finish');
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(p.b.state.datasets.some((d) => d.id === 'HDDs/apexos-backups/truenas/Documents')).toBe(true);
  });

  it('sends encrypted folders raw: the copy is encrypted and locked on B, and restores locked', async () => {
    const p = await pair();
    const docs = p.a.state.datasets.find((d) => d.id === 'HDDs/Documents')!;
    docs.encryption = newEncryption('PASSPHRASE', 'correct horse battery staple');
    const { repl } = await pushTask(p, 'Documents');
    await p.ca.call('pool.snapshot.create', [{ dataset: 'HDDs/Documents', naming_schema: 'apexosbk-b-%Y%m%d-%H%M%S', recursive: true }]);
    await p.ca.job('replication.run', [repl.id]);
    const copy = await p.cb.call<Any>('pool.dataset.get_instance', ['HDDs/apexos-backups/truenas/Documents']);
    expect(copy).toMatchObject({ encrypted: true, locked: true, key_loaded: false, encryption_root: 'HDDs/apexos-backups/truenas/Documents' });
    expect(p.b.state.datasets.find((d) => d.id === copy.id)!.encryption).toMatchObject({ keyFormat: 'PASSPHRASE', keyLoaded: false, secret: 'correct horse battery staple' });
    expect(copy.key_format.value).toBe('PASSPHRASE');
    expect(p.b.state.fs.nodes.some((n) => n.path.startsWith('/mnt/HDDs/apexos-backups/truenas/Documents/'))).toBe(false);

    // Restore with a one-off PULL into a new dataset on A: it arrives locked and unlocks with the passphrase.
    const snap = p.b.state.snapshots.find((s) => s.dataset === 'HDDs/apexos-backups/truenas/Documents')!;
    await p.ca.job('replication.run_onetime', [
      {
        direction: 'PULL',
        transport: 'SSH',
        ssh_credentials: p.credId,
        sudo: true,
        source_datasets: ['HDDs/apexos-backups/truenas/Documents'],
        target_dataset: 'HDDs/Documents-restored',
        recursive: true,
        properties: true,
        properties_exclude: ['readonly'],
        name_regex: snap.name,
        retention_policy: 'NONE',
        readonly: 'IGNORE',
        only_from_scratch: true,
      },
    ]);
    const restored = await p.ca.call<Any>('pool.dataset.get_instance', ['HDDs/Documents-restored']);
    expect(restored).toMatchObject({ encrypted: true, locked: true });
    expect(restored.readonly.parsed).toBe(false);
    const bad = await p.ca.job<Any>('pool.dataset.unlock', ['HDDs/Documents-restored', { datasets: [{ name: 'HDDs/Documents-restored', passphrase: 'wrong' }] }]);
    expect(bad.failed['HDDs/Documents-restored'].error).toMatch(/Invalid Key/);
    const ok = await p.ca.job<Any>('pool.dataset.unlock', ['HDDs/Documents-restored', { datasets: [{ name: 'HDDs/Documents-restored', passphrase: 'correct horse battery staple' }] }]);
    expect(ok.unlocked).toEqual(['HDDs/Documents-restored']);
  });

  it('restores an unencrypted copy with its files and refuses an existing target', async () => {
    const p = await pair();
    const { repl } = await pushTask(p, 'Photos');
    await p.ca.call('pool.snapshot.create', [{ dataset: 'HDDs/Photos', naming_schema: 'apexosbk-b-%Y%m%d-%H%M%S', recursive: true }]);
    await p.ca.job('replication.run', [repl.id]);
    const args = {
      direction: 'PULL',
      transport: 'SSH',
      ssh_credentials: p.credId,
      sudo: true,
      source_datasets: ['HDDs/apexos-backups/truenas/Photos'],
      target_dataset: 'HDDs/Photos-old',
      recursive: true,
      properties: true,
      properties_exclude: ['readonly'],
      name_regex: 'apexosbk-b-.*',
      retention_policy: 'NONE',
      readonly: 'IGNORE',
      only_from_scratch: true,
    };
    await p.ca.job('replication.run_onetime', [args]);
    expect(p.a.state.fs.nodes.some((n) => n.path === '/mnt/HDDs/Photos-old/IMG_4821.HEIC')).toBe(true);
    const again = await failure(p.ca.job('replication.run_onetime', [args]));
    expect(again.message).toMatch(/Target dataset 'HDDs\/Photos-old' already exists/);
  });

  it('fails like zettarepl when B is unreachable, SSH is off, sudo is missing or the quota is exceeded', async () => {
    const p = await pair();
    const { repl } = await pushTask(p, 'Photos');
    await p.ca.call('pool.snapshot.create', [{ dataset: 'HDDs/Photos', naming_schema: 'apexosbk-b-%Y%m%d-%H%M%S', recursive: true }]);

    await p.cb.job('service.control', ['STOP', 'ssh', {}]);
    expect((await failure(p.ca.job('replication.run', [repl.id]))).message).toMatch(/Connection refused/);
    const state = (await p.ca.call<Any>('replication.get_instance', [repl.id])).state;
    expect(state).toMatchObject({ state: 'ERROR' });
    expect(state.error).toMatch(/Connection refused/);
    await p.cb.job('service.control', ['START', 'ssh', {}]);

    const user = p.b.state.users.find((u) => u.username === 'apexosbk_truenas')!;
    user.sudo_commands_nopasswd = [];
    expect((await failure(p.ca.job('replication.run', [repl.id]))).message).toMatch(/Passwordless `sudo` for `\/usr\/sbin\/zfs`/);
    user.sudo_commands_nopasswd = ['/usr/sbin/zfs'];

    await p.cb.call('pool.dataset.update', ['HDDs/apexos-backups/truenas', { quota: 100 * GiB, reservation: 100 * GiB }]);
    expect((await failure(p.ca.job('replication.run', [repl.id]))).message).toMatch(/space quota exceeded/);
    await p.cb.call('pool.dataset.update', ['HDDs/apexos-backups/truenas', { quota: 1024 * GiB }]);
    await p.ca.job('replication.run', [repl.id]);

    await p.b.close();
    expect((await failure(p.ca.job('replication.run', [repl.id]))).message).toMatch(/Unable to connect to port \d+ on 127\.0\.0\.1/);
  });

  it('checks the pinned host key and the key login', async () => {
    const p = await pair();
    const { repl } = await pushTask(p, 'Photos');
    await p.ca.call('pool.snapshot.create', [{ dataset: 'HDDs/Photos', naming_schema: 'apexosbk-b-%Y%m%d-%H%M%S', recursive: true }]);
    const user = p.b.state.users.find((u) => u.username === 'apexosbk_truenas')!;
    const key = user.sshpubkey;
    user.sshpubkey = null;
    expect((await failure(p.ca.job('replication.run', [repl.id]))).message).toMatch(/Authentication failed/);
    user.sshpubkey = key;
    await p.ca.call('keychaincredential.update', [p.credId, { attributes: { remote_host_key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOther' } }]);
    expect((await failure(p.ca.job('replication.run', [repl.id]))).message).toMatch(/Host key for server '127\.0\.0\.1' does not match/);
  });

  it('refuses unencrypted data under an encrypted target and encrypted data into an existing plain copy', async () => {
    const p = await pair();
    const parent = p.b.state.datasets.find((d) => d.id === 'HDDs/apexos-backups/truenas')!;
    parent.encryption = newEncryption('HEX', 'ab'.repeat(32));
    const { repl } = await pushTask(p, 'Photos');
    await p.ca.call('pool.snapshot.create', [{ dataset: 'HDDs/Photos', naming_schema: 'apexosbk-b-%Y%m%d-%H%M%S', recursive: true }]);
    expect((await failure(p.ca.job('replication.run', [repl.id]))).message).toMatch(/must be encrypted \(as one of its ancestors is encrypted\)/);
    delete parent.encryption;
    await p.ca.job('replication.run', [repl.id]);

    // Encrypting the folder afterwards breaks the chain: raw sends can't go into the old plain copy.
    const photos = p.a.state.datasets.find((d) => d.id === 'HDDs/Photos')!;
    photos.encryption = newEncryption('HEX', 'cd'.repeat(32));
    await new Promise((r) => setTimeout(r, 1100));
    await p.ca.call('pool.snapshot.create', [{ dataset: 'HDDs/Photos', naming_schema: 'apexosbk-b-%Y%m%d-%H%M%S', recursive: true }]);
    expect((await failure(p.ca.job('replication.run', [repl.id]))).message).toMatch(/Unable to send encrypted dataset 'HDDs\/Photos' to existing unencrypted or unrelated dataset/);
  });

  it('protects bound snapshot tasks and unlinks replications when their credentials are deleted', async () => {
    const p = await pair();
    const { task, repl } = await pushTask(p, 'Photos');
    expect((await failure(p.ca.call('pool.snapshottask.delete', [task.id]))).message).toMatch(/last periodic snapshot task bound to enabled replication task/);
    await p.ca.call('keychaincredential.delete', [p.credId, { cascade: true }]);
    expect(await p.ca.call<Any>('replication.get_instance', [repl.id])).toMatchObject({ enabled: false, ssh_credentials: null });
    await p.ca.call('replication.delete', [repl.id]);
    await p.ca.call('pool.snapshottask.delete', [task.id]);
  });

  it('keeps the SSH identity across restarts with a state file', async () => {
    const stateFile = join(dir, 'b.json');
    const p = await pair({ stateFile });
    const { repl } = await pushTask(p, 'Photos');
    await p.ca.call('pool.snapshot.create', [{ dataset: 'HDDs/Photos', naming_schema: 'apexosbk-b-%Y%m%d-%H%M%S', recursive: true }]);
    const port = p.b.sshAddress.port;
    const httpPort = p.b.server.port;
    await p.b.close();
    expect((await failure(p.ca.job('replication.run', [repl.id]))).message).toMatch(/Connection refused/);
    const again = await startMockTrueNas({ jobDelayMs: 0, stateFile, port: httpPort });
    try {
      expect(again.sshAddress.port).toBe(port);
      await p.ca.job('replication.run', [repl.id]);
      expect(again.state.datasets.some((d) => d.id === 'HDDs/apexos-backups/truenas/Photos')).toBe(true);
    } finally {
      await again.close();
    }
  });
});
