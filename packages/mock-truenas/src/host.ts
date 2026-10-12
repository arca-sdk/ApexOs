/**
 * A tiny simulation of the TrueNAS host shell, used by `cronjob.run`: enough of `sh -c` (quoting, `;`,
 * redirections, `$?`), `sudo` and a few binaries (zpool, smartctl, rm) for ApexOs's host helper.
 */
import type { Mock } from './context.ts';
import type { DiskState, PoolState, SmartState, UserState } from './state.ts';
import { diskById, diskByName, emitPool, partName, poolLeaves } from './storage.ts';

interface Token {
  value: string;
  /** `$?` may be expanded (unquoted or double-quoted). */
  expandable: boolean;
}

/** Splits a shell line into commands (`;`) and arguments, honouring single/double quotes and backslashes. */
export function parseShell(line: string): Token[][] {
  const commands: Token[][] = [];
  let args: Token[] = [];
  let current = '';
  let inToken = false;
  let expandable = true;
  let quote: "'" | '"' | null = null;
  const endToken = () => {
    if (inToken) args.push({ value: current, expandable });
    current = '';
    inToken = false;
    expandable = true;
  };
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '\\' && i + 1 < line.length && '"\\$'.includes(line[i + 1]!)) current += line[++i];
      else current += ch;
      continue;
    }
    if (ch === "'") {
      quote = "'";
      inToken = true;
      expandable = false;
    } else if (ch === '"') {
      quote = '"';
      inToken = true;
    } else if (ch === '\\' && i + 1 < line.length) {
      current += line[++i];
      inToken = true;
    } else if (ch === ';') {
      endToken();
      if (args.length) commands.push(args);
      args = [];
    } else if (/\s/.test(ch)) {
      endToken();
    } else {
      current += ch;
      inToken = true;
    }
  }
  if (quote) throw new Error('sh: 1: Syntax error: Unterminated quoted string');
  endToken();
  if (args.length) commands.push(args);
  return commands;
}

const REDIRECTION = /^\d*>(&\d+|\/dev\/null)?$/;

export interface ShellResult {
  output: string;
  code: number;
}

/** Binaries ApexOs's helper may run, by full path; bare names resolve to these too. */
const BIN_PATHS: Record<string, string> = {
  zpool: '/usr/sbin/zpool',
  smartctl: '/usr/sbin/smartctl',
  rm: '/usr/bin/rm',
  mv: '/usr/bin/mv',
  cp: '/usr/bin/cp',
};

function resolveBin(name: string): string | null {
  if (name.startsWith('/')) return Object.values(BIN_PATHS).includes(name) ? name : null;
  return BIN_PATHS[name] ?? null;
}

function sudoAllowed(user: UserState, bin: string): boolean {
  return user.sudo_commands_nopasswd.some((c) => c === 'ALL' || c === bin || c.split(/\s+/)[0] === bin);
}

/** Runs a shell line as `username`, returning combined stdout/stderr and the exit code of the last command. */
export function runShell(mock: Mock, username: string, line: string): ShellResult {
  const user = mock.state.users.find((u) => u.username === username);
  if (!user) return { output: `sudo: unknown user ${username}\n`, code: 1 };
  let commands: Token[][];
  try {
    commands = parseShell(line);
  } catch (err) {
    return { output: `${(err as Error).message}\n`, code: 2 };
  }
  let output = '';
  let last = 0;
  for (const tokens of commands) {
    const argv = tokens
      .filter((t) => !REDIRECTION.test(t.value))
      .map((t) => (t.expandable ? t.value.replace(/\$\?/g, String(last)) : t.value));
    if (!argv.length) continue;
    const res = runCommand(mock, user, argv);
    output += res.output;
    last = res.code;
  }
  return { output, code: last };
}

function runCommand(mock: Mock, user: UserState, argv: string[]): ShellResult {
  const [cmd, ...rest] = argv;
  if (cmd === 'echo') return { output: `${rest.join(' ')}\n`, code: 0 };
  if (cmd === 'true') return { output: '', code: 0 };
  let args = rest;
  let asRoot = user.uid === 0;
  let bin: string | null;
  if (cmd === 'sudo') {
    args = [...rest];
    while (args[0]?.startsWith('-')) args.shift(); // -n, -H …
    const target = args.shift() ?? '';
    bin = resolveBin(target);
    if (!bin) return { output: `sudo: ${target}: command not found\n`, code: 1 };
    if (!asRoot && !sudoAllowed(user, bin)) {
      return { output: 'sudo: a password is required\n', code: 1 };
    }
    asRoot = true;
  } else {
    bin = resolveBin(cmd ?? '');
    if (!bin) return { output: `sh: 1: ${cmd}: not found\n`, code: 127 };
  }
  if (!asRoot) return { output: `${bin.split('/').pop()}: Permission denied\n`, code: 1 };
  switch (bin) {
    case BIN_PATHS.zpool:
      return zpool(mock, args);
    case BIN_PATHS.smartctl:
      return smartctl(mock, args);
    case BIN_PATHS.rm:
      return rm(mock, args);
    default:
      return { output: '', code: 0 };
  }
}

function findPool(mock: Mock, name: string | undefined): PoolState | undefined {
  return mock.state.pools.find((p) => p.name === name);
}

function leafLabel(mock: Mock, leafDisk: string, partuuid: string): string {
  return partuuid || diskById(mock.state, leafDisk)?.name || leafDisk;
}

function zpoolStatus(mock: Mock, pool: PoolState, verbose: boolean): string {
  const rows: string[] = [];
  const line = (name: string, state: string, r = 0, w = 0, c = 0) =>
    rows.push(`\t${name.padEnd(42)} ${state.padEnd(8)} ${String(r).padStart(5)} ${String(w).padStart(5)} ${String(c).padStart(5)}`);
  let totals = { r: 0, w: 0, c: 0 };
  for (const ref of poolLeaves(pool)) {
    totals = { r: totals.r + ref.leaf.errors.read, w: totals.w + ref.leaf.errors.write, c: totals.c + ref.leaf.errors.checksum };
  }
  const errors = pool.dataErrors ?? [];
  const status = errors.length || totals.r + totals.w + totals.c ? 'ONLINE' : 'ONLINE';
  line(pool.name, status, 0, 0, errors.length ? errors.length * 2 : 0);
  pool.topology.data.forEach((v, i) => {
    if (v.type !== 'STRIPE') line(`  ${v.type === 'MIRROR' ? 'mirror' : v.type.toLowerCase()}-${i}`, 'ONLINE');
    for (const leaf of v.children) {
      line(`${v.type === 'STRIPE' ? '  ' : '    '}${leafLabel(mock, leaf.disk, leaf.partuuid)}`, leaf.status, leaf.errors.read, leaf.errors.write, leaf.errors.checksum);
    }
  });
  const scan = pool.scan;
  const scanLine = scan
    ? scan.state === 'SCANNING'
      ? `${scan.function === 'SCRUB' ? 'scrub' : 'resilver'} in progress, ${scan.percentage.toFixed(2)}% done`
      : `${scan.function === 'SCRUB' ? 'scrub repaired 0B' : 'resilvered'} in 00:00:05 with ${scan.errors} errors on ${new Date(scan.end_time ?? Date.now()).toUTCString()}`
    : 'none requested';
  const out = [
    `  pool: ${pool.name}`,
    ` state: ONLINE`,
    ...(errors.length
      ? [
          'status: One or more devices has experienced an error resulting in data',
          '\tcorruption.  Applications may be affected.',
          'action: Restore the file in question if possible.  Otherwise restore the',
          '\tentire pool from backup.',
          '   see: https://openzfs.github.io/openzfs-docs/msg/ZFS-8000-8A',
        ]
      : []),
    `  scan: ${scanLine}`,
    'config:',
    '',
    `\t${'NAME'.padEnd(42)} ${'STATE'.padEnd(8)}  READ WRITE CKSUM`,
    ...rows,
    '',
  ];
  if (!errors.length) out.push('errors: No known data errors');
  else if (!verbose) out.push(`errors: ${errors.length} data errors, use '-v' for a list`);
  else out.push('errors: Permanent errors have been detected in the following files:', '', ...errors.map((e) => `        ${e}`));
  return `${out.join('\n')}\n`;
}

function zpool(mock: Mock, args: string[]): ShellResult {
  const [sub, ...rest] = args;
  if (sub === 'status') {
    const verbose = rest.includes('-v');
    const names = rest.filter((a) => !a.startsWith('-'));
    const pools = names.length ? names.map((n) => findPool(mock, n)) : mock.state.pools;
    if (pools.some((p) => !p)) return { output: `cannot open '${names.join(' ')}': no such pool\n`, code: 1 };
    return { output: (pools as PoolState[]).map((p) => zpoolStatus(mock, p, verbose)).join('\n'), code: 0 };
  }
  if (sub === 'clear') {
    const [poolName, device] = rest.filter((a) => !a.startsWith('-'));
    const pool = findPool(mock, poolName);
    if (!pool) return { output: `cannot open '${poolName ?? ''}': no such pool\n`, code: 1 };
    let matched = false;
    for (const ref of poolLeaves(pool)) {
      const d = diskById(mock.state, ref.leaf.disk);
      const names = [ref.leaf.guid, ref.leaf.partuuid, d?.name, d ? partName(d, 1) : undefined, d ? `/dev/${d.name}` : undefined];
      if (device && !names.includes(device)) continue;
      matched = true;
      ref.leaf.errors = { read: 0, write: 0, checksum: 0 };
    }
    if (device && !matched) return { output: `cannot clear errors for ${device}: no such device in pool\n`, code: 1 };
    emitPool(mock, pool);
    return { output: '', code: 0 };
  }
  return { output: `unrecognized command '${sub ?? ''}'\n`, code: 2 };
}

export const HEALTHY_SMART: SmartState = {
  passed: true,
  reallocatedSectors: 0,
  pendingSectors: 0,
  offlineUncorrectable: 0,
  mediaErrors: 0,
  powerOnHours: 9_312,
};

function smartctl(mock: Mock, args: string[]): ShellResult {
  const device = args.find((a) => a.startsWith('/dev/'));
  const disk: DiskState | undefined = device ? diskByName(mock.state, device.slice(5).replace(/p?\d+$/, '')) : undefined;
  if (!device || !disk || !disk.present) {
    const out = { smartctl: { exit_status: 2, messages: [{ string: `${device ?? ''}: Unable to detect device type`, severity: 'error' }] } };
    return { output: `${JSON.stringify(out)}\n`, code: 2 };
  }
  const smart = disk.smart ?? HEALTHY_SMART;
  const exit = smart.passed ? 0 : 8;
  const base = {
    json_format_version: [1, 0],
    smartctl: { exit_status: exit },
    device: { name: device, type: disk.subsystem === 'nvme' ? 'nvme' : 'sat' },
    model_name: disk.model,
    serial_number: disk.serial,
    smart_status: { passed: smart.passed },
    power_on_time: { hours: smart.powerOnHours },
    temperature: { current: disk.tempOverride ?? disk.baseTemp ?? 35 },
  };
  const out =
    disk.subsystem === 'nvme'
      ? { ...base, nvme_smart_health_information_log: { critical_warning: smart.passed ? 0 : 4, media_errors: smart.mediaErrors, power_on_hours: smart.powerOnHours } }
      : {
          ...base,
          ata_smart_attributes: {
            table: [
              { id: 5, name: 'Reallocated_Sector_Ct', raw: { value: smart.reallocatedSectors, string: String(smart.reallocatedSectors) } },
              { id: 9, name: 'Power_On_Hours', raw: { value: smart.powerOnHours, string: String(smart.powerOnHours) } },
              { id: 197, name: 'Current_Pending_Sector', raw: { value: smart.pendingSectors, string: String(smart.pendingSectors) } },
              { id: 198, name: 'Offline_Uncorrectable', raw: { value: smart.offlineUncorrectable, string: String(smart.offlineUncorrectable) } },
            ],
          },
        };
  return { output: `${JSON.stringify(out, null, 2)}\n`, code: exit };
}

function rm(mock: Mock, args: string[]): ShellResult {
  const paths: string[] = [];
  let force = false;
  let endOfOptions = false;
  for (const a of args) {
    if (!endOfOptions && a === '--') endOfOptions = true;
    else if (!endOfOptions && a.startsWith('-')) force ||= a.includes('f');
    else paths.push(a);
  }
  let output = '';
  let code = 0;
  for (const path of paths) {
    let removed = false;
    for (const pool of mock.state.pools) {
      const i = pool.dataErrors?.indexOf(path) ?? -1;
      if (i < 0) continue;
      // ZFS keeps listing a deleted damaged file by object number until the next scrub.
      pool.dataErrors![i] = `<0x${(0x40 + i).toString(16)}>:<0x${(0x1a0 + i).toString(16)}>`;
      removed = true;
      emitPool(mock, pool);
    }
    if (!removed && !force) {
      output += `rm: cannot remove '${path}': No such file or directory\n`;
      code = 1;
    }
  }
  return { output, code };
}
