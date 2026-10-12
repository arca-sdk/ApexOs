import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMockTrueNas, type MockTrueNas } from '@apexos/mock-truenas';
import { buildCommandLine, HELPER_USER, HostCommands, parseHostLog, shellQuote } from '../src/lib/host.ts';
import { TrueNasManager } from '../src/lib/truenas.ts';

describe('command building', () => {
  it('single-quotes every argument', () => {
    expect(shellQuote(`it's`)).toBe(`'it'\\''s'`);
    expect(buildCommandLine('zpool', ['status', '-v', 'tank'])).toBe(
      "echo __APEXOS_BEGIN__; sudo -n /usr/sbin/zpool 'status' '-v' 'tank' 2>&1; echo __APEXOS_END__ $?",
    );
  });
  it('rejects line breaks and unknown binaries', () => {
    expect(() => shellQuote('a\nb')).toThrow();
    expect(() => buildCommandLine('bash' as never, [])).toThrow(/not allowed/);
  });
  it('parses output and exit status from a cron log', () => {
    const log = '__APEXOS_BEGIN__\nline 1\nline 2\n__APEXOS_END__ 3\nExecuted CronTask - …: __APEXOS_BEGIN__\nline 1\n';
    expect(parseHostLog(log)).toEqual({ output: 'line 1\nline 2\n', code: 3 });
    expect(parseHostLog('garbage')).toBeNull();
  });
});

describe('HostCommands against the simulated TrueNAS', () => {
  let mock: MockTrueNas;
  let truenas: TrueNasManager;
  let host: HostCommands;

  beforeAll(async () => {
    mock = await startMockTrueNas({ jobDelayMs: 0, scenario: 'configured' });
    // If root had an e-mail address, running as root would mail every command's output.
    const root = mock.state.users.find((u) => u.username === 'root')!;
    root.email = 'admin@example.com';
    truenas = new TrueNasManager();
    await truenas.configure({ url: mock.url, auth: { type: 'apiKey', apiKey: 'demo-api-key' } });
    host = new HostCommands(truenas);
  });

  afterAll(async () => {
    await truenas.close();
    await mock.close();
  });

  it('creates the restricted helper account on first use', async () => {
    const out = await host.runChecked('zpool', ['status', '-v', 'HDDs']);
    expect(out).toContain('pool: HDDs');
    expect(out).toContain('errors: No known data errors');
    const helper = mock.state.users.find((u) => u.username === HELPER_USER)!;
    expect(helper).toMatchObject({ password_disabled: true, smb: false });
    expect(helper.sudo_commands_nopasswd).toContain('/usr/sbin/zpool');
  });

  it('cleans up its cron jobs and never mails output', async () => {
    await host.run('zpool', ['status', 'SSDs']);
    const cronjobs = await truenas.client().call<unknown[]>('cronjob.query');
    expect(cronjobs).toEqual([]);
    expect(mock.mailLog).toEqual([]);
  });

  it('keeps hostile arguments literal', async () => {
    const result = await host.run('zpool', ['status', "HDDs'; rm -rf / #"]);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('no such pool');
  });

  it('reads long outputs completely through the log download', async () => {
    const files = Array.from({ length: 40 }, (_, i) => `/mnt/HDDs/Media/file-${i}.mkv`);
    mock.setDataErrors('HDDs', files);
    const out = await host.runChecked('zpool', ['status', '-v', 'HDDs']);
    for (const f of files) expect(out).toContain(f);
    mock.setDataErrors('HDDs', []);
  });

  it('reports non-zero exit codes', async () => {
    mock.setSmart('sdb', { passed: false, reallocatedSectors: 12 });
    const result = await host.run('smartctl', ['-j', '-H', '-A', '/dev/sdb']);
    expect(result.code).toBe(8);
    const json = JSON.parse(result.output) as { smart_status: { passed: boolean } };
    expect(json.smart_status.passed).toBe(false);
    await expect(host.runChecked('smartctl', ['-j', '-H', '/dev/sdb'])).rejects.toThrow(/exit 8/);
  });

  it('clears error counters with zpool clear', async () => {
    mock.addDriveErrors('sdc', { checksum: 4 });
    await host.runChecked('zpool', ['clear', 'HDDs', 'sdc']);
    const leaf = mock.state.pools
      .find((p) => p.name === 'HDDs')!
      .topology.data.flatMap((v) => v.children)
      .find((l) => mock.state.disks.find((d) => d.identifier === l.disk)?.name === 'sdc')!;
    expect(leaf.errors).toEqual({ read: 0, write: 0, checksum: 0 });
  });
});
