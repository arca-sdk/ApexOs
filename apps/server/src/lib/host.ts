/**
 * Runs a small, fixed set of commands on the TrueNAS host for things the middleware API does not
 * expose (reading `zpool status -v`, `zpool clear`, SMART data, file operations).
 *
 * How it works, using only public API calls:
 * - A hidden service account (`apexos_helper`: no password, no shell, no SMB) is allowed to `sudo`
 *   exactly the binaries in ALLOWED_BINARIES.
 * - Each run creates a disabled cron job for that account, runs it once with `cronjob.run`, reads the
 *   job's log through `core.job_download_logs`, and deletes the cron job again.
 * - Running as the helper (which has no e-mail address) instead of root also stops TrueNAS from mailing
 *   the command output to root.
 *
 * Safety: callers pass an argv array; every argument is validated (no NUL/newline) and single-quoted,
 * and only allow-listed absolute binary paths are ever invoked, so arguments can never become shell syntax.
 */
import type { TrueNasClient } from '@apexos/truenas-client';
import type { TrueNasManager } from './truenas.ts';

export const HELPER_USER = 'apexos_helper';

export const ALLOWED_BINARIES = {
  zpool: '/usr/sbin/zpool',
  smartctl: '/usr/sbin/smartctl',
  rm: '/usr/bin/rm',
  mv: '/usr/bin/mv',
  cp: '/usr/bin/cp',
} as const;

export type HostBinary = keyof typeof ALLOWED_BINARIES;

export interface HostResult {
  /** Combined stdout and stderr of the command. */
  output: string;
  /** Exit status of the command. */
  code: number;
}

export class HostCommandError extends Error {
  constructor(
    message: string,
    readonly result?: HostResult,
  ) {
    super(message);
    this.name = 'HostCommandError';
  }
}

const BEGIN = '__APEXOS_BEGIN__';
const END = '__APEXOS_END__';

/** POSIX single-quoting: the result is always exactly one shell word with no expansions. */
export function shellQuote(arg: string): string {
  if (/[\0\n\r]/.test(arg)) throw new HostCommandError('Arguments may not contain NUL or line breaks');
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** The single shell line run by cron: markers around the command so its output and exit status can be found in the log. */
export function buildCommandLine(binary: HostBinary, args: string[]): string {
  const path = ALLOWED_BINARIES[binary];
  if (!path) throw new HostCommandError(`Binary ${binary} is not allowed`);
  const quoted = args.map(shellQuote).join(' ');
  return `echo ${BEGIN}; sudo -n ${path}${quoted ? ` ${quoted}` : ''} 2>&1; echo ${END} $?`;
}

/** Extracts the command's output and exit status from a cron job log. */
export function parseHostLog(log: string): HostResult | null {
  const start = log.indexOf(`${BEGIN}\n`);
  if (start < 0) return null;
  const rest = log.slice(start + BEGIN.length + 1);
  const end = rest.search(new RegExp(`${END} (\\d+)`));
  if (end < 0) return null;
  const code = Number(/(\d+)/.exec(rest.slice(end + END.length))![1]);
  return { output: rest.slice(0, end), code };
}

export class HostCommands {
  private queue: Promise<unknown> = Promise.resolve();
  private helperReady?: TrueNasClient;

  constructor(private readonly truenas: TrueNasManager) {}

  /** Runs one allow-listed binary on the host. Runs are serialized. */
  run(binary: HostBinary, args: string[], opts: { timeoutMs?: number } = {}): Promise<HostResult> {
    const line = buildCommandLine(binary, args);
    const next = this.queue.then(() => this.execute(line, opts.timeoutMs ?? 120_000));
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Like `run`, but throws when the command exits non-zero. */
  async runChecked(binary: HostBinary, args: string[], opts: { timeoutMs?: number } = {}): Promise<string> {
    const result = await this.run(binary, args, opts);
    if (result.code !== 0) {
      const detail = result.output.trim().split('\n').slice(-3).join(' ');
      throw new HostCommandError(`${binary} failed (exit ${result.code})${detail ? `: ${detail}` : ''}`, result);
    }
    return result.output;
  }

  /** Creates or repairs the hidden helper account and its sudo rules. */
  async ensureHelper(client: TrueNasClient): Promise<void> {
    if (this.helperReady === client) return;
    const wanted = Object.values(ALLOWED_BINARIES);
    const [existing] = await client.call<{ id: number; sudo_commands_nopasswd: string[]; locked: boolean }[]>('user.query', [
      [['username', '=', HELPER_USER]],
    ]);
    if (!existing) {
      await client.call('user.create', [
        {
          username: HELPER_USER,
          full_name: 'ApexOs helper (used by ApexOs, do not delete)',
          password_disabled: true,
          smb: false,
          group_create: true,
          home: '/var/empty',
          shell: '/usr/sbin/nologin',
          sudo_commands: [],
          sudo_commands_nopasswd: wanted,
        },
      ]);
    } else if (wanted.some((w) => !existing.sudo_commands_nopasswd.includes(w))) {
      await client.call('user.update', [existing.id, { sudo_commands_nopasswd: wanted }]);
    }
    this.helperReady = client;
  }

  private async execute(line: string, timeoutMs: number): Promise<HostResult> {
    const client = this.truenas.client();
    await this.ensureHelper(client);
    const cron = await client.call<{ id: number }>('cronjob.create', [
      {
        command: line,
        user: HELPER_USER,
        description: 'ApexOs helper (temporary; removed automatically)',
        enabled: false,
        stdout: false,
        stderr: false,
        schedule: { minute: '00', hour: '00', dom: '1', month: '1', dow: '*' },
      },
    ]);
    try {
      const jobId = await client.call<number>('cronjob.run', [cron.id, false]);
      const job = await withTimeout(client.waitForJob(jobId), timeoutMs, 'The command on the server took too long');
      let log: string | null = null;
      try {
        const url = await client.call<string>('core.job_download_logs', [jobId, 'apexos-helper.log', true]);
        log = await client.downloadText(url);
      } catch {
        // Short outputs are complete in the excerpt (first and last 10 lines).
        log = (job as { logs_excerpt?: string | null }).logs_excerpt ?? null;
      }
      const parsed = log ? parseHostLog(log) : null;
      if (!parsed) {
        throw new HostCommandError(
          job.state === 'SUCCESS' ? 'Could not read the command output from TrueNAS' : `The command could not run: ${job.error ?? job.state}`,
        );
      }
      return parsed;
    } finally {
      await client.call('cronjob.delete', [cron.id]).catch(() => undefined);
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new HostCommandError(message)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
