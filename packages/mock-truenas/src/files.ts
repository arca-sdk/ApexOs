/**
 * The simulated file tree inside datasets (`state.fs.nodes`), as ApexOs's file browser uses it:
 *
 * - `POST /_upload` (multipart: a `data` part `{"method":"filesystem.put","params":[path,{append,mode}]}`
 *   first, then a `file` part) streams into a `filesystem.put` job, like `apps/file_app.py`.
 * - `core.download('filesystem.get', [path], filename, buffered)` + `GET /_download/<job>?auth_token=…`
 *   (single use, 60 s window unless buffered).
 * - `mv`, `cp` and `rm` for the simulated host shell (`src/host.ts`), following GNU coreutils for the
 *   options ApexOs uses. Child datasets appear as mountpoint directories: they can't be moved or removed,
 *   and `rm -r` / `cp -r` without `--one-file-system` really do descend into them.
 *
 * Only a file's size and its first bytes are stored (FILE_SAMPLE_BYTES, less once the state already
 * holds a lot of samples); reading a file back returns the sample followed by filler.
 *
 * Encryption is simulated elsewhere; if a dataset carries a `locked` flag, everything inside it behaves
 * as missing (its mountpoint is an empty directory) and writes fail like they do on a locked dataset.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { posix } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Mock } from './context.ts';
import { registerStreamingDownload } from './download.ts';
import { isLocked } from './encryption.ts';
import { userRoles } from './methods/accounts.ts';
import { callError, validationError } from './rpc.ts';
import type { DatasetState, FsNode, MockState } from './state.ts';
import { datasetAtPath, datasetContaining, effectiveAcl, getDataset, mountpoint, parentId, renderDataset } from './storage.ts';
import { isObj, seeded } from './util.ts';

/** Bytes of each uploaded file the simulator keeps (smaller files round-trip exactly). */
export const FILE_SAMPLE_BYTES = 16 * 1024;
/** Once the state holds this many sample bytes, new files keep only SMALL_SAMPLE_BYTES. */
const SAMPLE_BUDGET_BYTES = 16 * 1024 * 1024;
const SMALL_SAMPLE_BYTES = 512;
const MIN_DATASET_USED = 96 * 1024;
const MAX_SYMLINK_HOPS = 40;

type Kind = FsNode['type'];

export interface CommandResult {
  output: string;
  code: number;
}

// ---------------------------------------------------------------------------
// Paths, locks and lookups
// ---------------------------------------------------------------------------

function dirname(p: string): string {
  return posix.dirname(p);
}

function basename(p: string): string {
  return posix.basename(p);
}

/** Absolute, `.`/`..` resolved, no trailing slash (null for relative paths). */
function clean(raw: string): string | null {
  if (!raw.startsWith('/')) return null;
  const p = posix.normalize(raw);
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

/** The locked dataset (the containing one or an ancestor) hiding `path`, if any. */
export function lockedDatasetFor(state: MockState, path: string): DatasetState | undefined {
  let ds = datasetContaining(state, path);
  while (ds) {
    if (isLocked(state, ds)) return ds;
    const parent = parentId(ds.id);
    ds = parent ? getDataset(state, parent) : undefined;
  }
  return undefined;
}

/** True when `path` is inside a locked dataset (the locked dataset's own mountpoint still exists, empty). */
export function hiddenByLock(state: MockState, path: string): boolean {
  const ds = lockedDatasetFor(state, path);
  return !!ds && path !== mountpoint(ds);
}

/** True for a locked dataset's mountpoint: it exists but shows nothing. */
export function isLockedMount(state: MockState, path: string): boolean {
  const ds = lockedDatasetFor(state, path);
  return !!ds && path === mountpoint(ds);
}

/** Inode number of an entry that never got its own (seeded entries, dataset roots). */
export function pathInode(path: string): number {
  return Math.floor(seeded(path) * 100000) + 34;
}

let lastInode = 1_000_000;

/** A fresh inode number for a newly created entry. */
function newInode(state: MockState): number {
  for (const n of state.fs.nodes) if (n.inode && n.inode > lastInode) lastInode = n.inode;
  return ++lastInode;
}

function nodeAt(state: MockState, path: string): FsNode | undefined {
  return state.fs.nodes.find((n) => n.path === path);
}

function isMount(state: MockState, path: string): boolean {
  return !!datasetAtPath(state, path);
}

function kindAt(state: MockState, path: string): Kind | null {
  if (hiddenByLock(state, path)) return null;
  if (isMount(state, path)) return 'DIRECTORY';
  return nodeAt(state, path)?.type ?? null;
}

/** Entries directly inside `dir`: files, folders, links and child dataset mountpoints. */
function childPaths(state: MockState, dir: string): string[] {
  if (hiddenByLock(state, dir) || isLockedMount(state, dir)) return [];
  const out = new Set<string>();
  for (const n of state.fs.nodes) if (dirname(n.path) === dir && n.path !== dir) out.add(n.path);
  for (const ds of state.datasets) {
    if (ds.type !== 'FILESYSTEM') continue;
    const mp = mountpoint(ds);
    if (mp !== dir && dirname(mp) === dir) out.add(mp);
  }
  return [...out].sort();
}

/** True when a dataset is mounted somewhere below `path`. */
function hasMountBelow(state: MockState, path: string): boolean {
  return state.datasets.some((d) => d.type === 'FILESYSTEM' && mountpoint(d).startsWith(`${path}/`));
}

/** Paths can only be written inside an unlocked dataset. */
function writable(state: MockState, path: string): boolean {
  return !!datasetContaining(state, path) && !lockedDatasetFor(state, path);
}

/** Follows symlinks in the parent components of `path` (the kernel does; the last component is left alone). */
function resolveParents(state: MockState, path: string): string {
  let current = path;
  for (let hops = 0; hops < MAX_SYMLINK_HOPS; hops++) {
    const parts = current.split('/').filter(Boolean);
    let changed = false;
    for (let i = 1; i < parts.length; i++) {
      const prefix = `/${parts.slice(0, i).join('/')}`;
      const node = nodeAt(state, prefix);
      if (node?.type === 'SYMLINK' && node.target) {
        const target = node.target.startsWith('/') ? node.target : posix.join(dirname(prefix), node.target);
        current = clean(`${target}/${parts.slice(i).join('/')}`) ?? current;
        changed = true;
        break;
      }
    }
    if (!changed) return current;
  }
  return current;
}

/** Like `resolveParents`, but also follows a symlink in the last component (what `open()` does). */
function resolveAll(state: MockState, path: string): string {
  let current = resolveParents(state, path);
  for (let hops = 0; hops < MAX_SYMLINK_HOPS; hops++) {
    const node = nodeAt(state, current);
    if (node?.type !== 'SYMLINK' || !node.target) return current;
    const target = node.target.startsWith('/') ? node.target : posix.join(dirname(current), node.target);
    current = resolveParents(state, clean(target) ?? current);
  }
  return current;
}

// ---------------------------------------------------------------------------
// Tree changes (with dataset space accounting)
// ---------------------------------------------------------------------------

/** Collects per-dataset size changes and reports them once at the end of an operation. */
class Usage {
  private readonly deltas = new Map<DatasetState, number>();

  constructor(private readonly mock: Mock) {}

  add(path: string, bytes: number): void {
    const ds = datasetContaining(this.mock.state, path);
    if (ds && bytes) this.deltas.set(ds, (this.deltas.get(ds) ?? 0) + bytes);
  }

  flush(): void {
    for (const [ds, delta] of this.deltas) {
      if (!delta) continue;
      ds.usedBytes = Math.max(MIN_DATASET_USED, ds.usedBytes + delta);
      if (this.mock.state.datasets.includes(ds)) this.mock.emit('pool.dataset.query', 'changed', ds.id, renderDataset(this.mock.state, ds));
    }
    this.deltas.clear();
  }
}

function deleteEntry(state: MockState, path: string, usage: Usage): void {
  const i = state.fs.nodes.findIndex((n) => n.path === path);
  if (i >= 0) {
    const [node] = state.fs.nodes.splice(i, 1);
    if (node?.type === 'FILE') usage.add(path, -node.size);
  }
  delete state.fs.owners[path];
  delete state.fs.acls[path];
}

function renameKeys<T>(map: Record<string, T>, from: string, to: string): void {
  for (const key of Object.keys(map)) {
    if (key === from || key.startsWith(`${from}/`)) {
      map[to + key.slice(from.length)] = map[key]!;
      delete map[key];
    }
  }
}

function moveTree(state: MockState, from: string, to: string, usage: Usage): void {
  for (const n of state.fs.nodes) {
    if (n.path !== from && !n.path.startsWith(`${from}/`)) continue;
    const next = to + n.path.slice(from.length);
    n.inode ??= pathInode(n.path);
    if (n.type === 'FILE') {
      usage.add(n.path, -n.size);
      usage.add(next, n.size);
    }
    n.path = next;
  }
  renameKeys(state.fs.owners, from, to);
  renameKeys(state.fs.acls, from, to);
}

/** Creates missing directories down to `dir` (root-owned, like `os.makedirs` in the middleware). */
function makeDirs(state: MockState, dir: string, now: number): void {
  if (kindAt(state, dir) === 'DIRECTORY') return;
  const parent = dirname(dir);
  if (parent !== dir) makeDirs(state, parent, now);
  const kind = kindAt(state, dir);
  if (kind === 'DIRECTORY') return;
  if (kind) throw callError('EFAULT', `[Errno 20] Not a directory: '${dir}'`);
  if (!writable(state, dir)) throw callError('EFAULT', `[Errno 2] No such file or directory: '${dir}'`);
  state.fs.nodes.push({ path: dir, type: 'DIRECTORY', size: 2, mtime: now, inode: newInode(state) });
}

// ---------------------------------------------------------------------------
// GNU-style argument parsing for mv / cp / rm
// ---------------------------------------------------------------------------

interface CommandSpec {
  name: string;
  /** Short option letter → canonical long name. */
  short: Record<string, string>;
  long: string[];
  /** Long options that take a value. */
  withValue: string[];
}

interface ParsedCommand {
  flags: Set<string>;
  values: Record<string, string>;
  operands: string[];
}

class UsageError extends Error {}

function parseCommand(spec: CommandSpec, args: string[]): ParsedCommand {
  const flags = new Set<string>();
  const values: Record<string, string> = {};
  const operands: string[] = [];
  let end = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (end || a === '-' || !a.startsWith('-')) {
      operands.push(a);
    } else if (a === '--') {
      end = true;
    } else if (a.startsWith('--')) {
      const [name, inline] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
      if (!spec.long.includes(name)) throw new UsageError(`${spec.name}: unrecognized option '${a}'`);
      if (spec.withValue.includes(name)) {
        const value = inline ?? args[++i];
        if (value === undefined) throw new UsageError(`${spec.name}: option '--${name}' requires an argument`);
        values[name] = value;
      } else {
        flags.add(name);
        if (inline !== undefined) values[name] = inline;
      }
    } else {
      for (let j = 1; j < a.length; j++) {
        const long = spec.short[a[j]!];
        if (!long) throw new UsageError(`${spec.name}: invalid option -- '${a[j]}'`);
        if (spec.withValue.includes(long)) {
          const value = a.slice(j + 1) || args[++i];
          if (value === undefined) throw new UsageError(`${spec.name}: option requires an argument -- '${a[j]}'`);
          values[long] = value;
          break;
        }
        flags.add(long);
      }
    }
  }
  return { flags, values, operands };
}

const MV: CommandSpec = {
  name: 'mv',
  short: { n: 'no-clobber', f: 'force', T: 'no-target-directory', t: 'target-directory', v: 'verbose', i: 'interactive', u: 'update' },
  long: ['no-clobber', 'force', 'no-target-directory', 'target-directory', 'verbose', 'interactive', 'update'],
  withValue: ['target-directory'],
};

const CP: CommandSpec = {
  name: 'cp',
  short: {
    a: 'archive',
    r: 'recursive',
    R: 'recursive',
    n: 'no-clobber',
    f: 'force',
    T: 'no-target-directory',
    t: 'target-directory',
    x: 'one-file-system',
    p: 'preserve',
    d: 'no-dereference',
    P: 'no-dereference',
    v: 'verbose',
  },
  long: ['archive', 'recursive', 'no-clobber', 'force', 'no-target-directory', 'target-directory', 'one-file-system', 'preserve', 'no-dereference', 'reflink', 'sparse', 'verbose', 'update'],
  withValue: ['target-directory'],
};

const RM: CommandSpec = {
  name: 'rm',
  short: { r: 'recursive', R: 'recursive', f: 'force', d: 'dir', v: 'verbose', i: 'interactive', I: 'interactive' },
  long: ['recursive', 'force', 'dir', 'verbose', 'interactive', 'one-file-system', 'preserve-root', 'no-preserve-root'],
  withValue: [],
};

/** Source → destination pairs for mv/cp (`-t DIR`, `-T SRC DST`, or `SRC… DEST`). */
function targetPairs(state: MockState, cmd: string, parsed: ParsedCommand): Array<[string, string]> {
  const { operands, values, flags } = parsed;
  const dir = values['target-directory'];
  if (dir !== undefined) {
    if (flags.has('no-target-directory')) throw new UsageError(`${cmd}: cannot combine --target-directory (-t) and --no-target-directory (-T)`);
    if (!operands.length) throw new UsageError(`${cmd}: missing file operand`);
    const d = clean(dir);
    if (!d || kindAt(state, resolveParents(state, d)) !== 'DIRECTORY') throw new UsageError(`${cmd}: target directory '${dir}': No such file or directory`);
    return operands.map((s) => [s, `${d}/${basename(s)}`]);
  }
  if (!operands.length) throw new UsageError(`${cmd}: missing file operand`);
  if (operands.length === 1) throw new UsageError(`${cmd}: missing destination file operand after '${operands[0]}'`);
  if (flags.has('no-target-directory')) {
    if (operands.length > 2) throw new UsageError(`${cmd}: extra operand '${operands[2]}'`);
    return [[operands[0]!, operands[1]!]];
  }
  const dest = operands[operands.length - 1]!;
  const sources = operands.slice(0, -1);
  const d = clean(dest);
  const destIsDir = !!d && kindAt(state, resolveAll(state, d)) === 'DIRECTORY';
  if (sources.length > 1 && !destIsDir) throw new UsageError(`${cmd}: target '${dest}': Not a directory`);
  return sources.map((s) => [s, destIsDir ? `${d}/${basename(s)}` : dest]);
}

function run(spec: CommandSpec, mock: Mock, args: string[], body: (parsed: ParsedCommand, out: string[], usage: Usage) => boolean): CommandResult {
  const out: string[] = [];
  const usage = new Usage(mock);
  let ok: boolean;
  try {
    ok = body(parseCommand(spec, args), out, usage);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    out.push(err.message);
    ok = false;
  }
  usage.flush();
  return { output: out.map((l) => `${l}\n`).join(''), code: ok ? 0 : 1 };
}

// ---------------------------------------------------------------------------
// mv
// ---------------------------------------------------------------------------

export function mvCommand(mock: Mock, args: string[]): CommandResult {
  const { state } = mock;
  return run(MV, mock, args, (parsed, out, usage) => {
    let ok = true;
    for (const [rawSrc, rawDst] of targetPairs(state, 'mv', parsed)) {
      const fail = (msg: string) => {
        out.push(msg);
        ok = false;
      };
      const src = clean(rawSrc) && resolveParents(state, clean(rawSrc)!);
      const dst = clean(rawDst) && resolveParents(state, clean(rawDst)!);
      const sk = src ? kindAt(state, src) : null;
      if (!src || !sk) {
        fail(`mv: cannot stat '${rawSrc}': No such file or directory`);
        continue;
      }
      if (!dst || kindAt(state, dirname(dst)) !== 'DIRECTORY') {
        fail(`mv: cannot move '${rawSrc}' to '${rawDst}': No such file or directory`);
        continue;
      }
      if (isMount(state, src) || hasMountBelow(state, src)) {
        fail(`mv: cannot move '${rawSrc}' to '${rawDst}': Device or resource busy`);
        continue;
      }
      if (dst === src) {
        fail(`mv: '${rawSrc}' and '${rawDst}' are the same file`);
        continue;
      }
      if (dst.startsWith(`${src}/`)) {
        fail(`mv: cannot move '${rawSrc}' to a subdirectory of itself, '${rawDst}'`);
        continue;
      }
      if (!writable(state, dst) || !writable(state, src)) {
        fail(`mv: cannot move '${rawSrc}' to '${rawDst}': Permission denied`);
        continue;
      }
      const dk = kindAt(state, dst);
      if (dk) {
        if (parsed.flags.has('no-clobber')) continue; // coreutils 9.1: skipped silently, exit status 0
        if (isMount(state, dst)) {
          fail(`mv: cannot move '${rawSrc}' to '${rawDst}': Device or resource busy`);
          continue;
        }
        if (dk === 'DIRECTORY' && sk !== 'DIRECTORY') {
          fail(`mv: cannot overwrite directory '${rawDst}' with non-directory`);
          continue;
        }
        if (dk !== 'DIRECTORY' && sk === 'DIRECTORY') {
          fail(`mv: cannot overwrite non-directory '${rawDst}' with directory '${rawSrc}'`);
          continue;
        }
        if (dk === 'DIRECTORY' && childPaths(state, dst).length) {
          fail(`mv: cannot move '${rawSrc}' to '${rawDst}': Directory not empty`);
          continue;
        }
        deleteEntry(state, dst, usage);
      }
      moveTree(state, src, dst, usage);
    }
    return ok;
  });
}

// ---------------------------------------------------------------------------
// cp
// ---------------------------------------------------------------------------

interface CopyOptions {
  noClobber: boolean;
  preserve: boolean;
  oneFileSystem: boolean;
  now: number;
}

function copyEntry(state: MockState, src: string, dst: string, opts: CopyOptions, out: string[], usage: Usage): boolean {
  const sk = kindAt(state, src)!;
  const dk = kindAt(state, dst);
  const copyMeta = () => {
    if (opts.preserve && state.fs.owners[src]) state.fs.owners[dst] = { ...state.fs.owners[src]! };
    else delete state.fs.owners[dst];
    if (opts.preserve && state.fs.acls[src]) state.fs.acls[dst] = structuredClone(state.fs.acls[src]!);
  };
  if (sk === 'DIRECTORY') {
    if (dk && dk !== 'DIRECTORY') {
      out.push(`cp: cannot overwrite non-directory '${dst}' with directory '${src}'`);
      return false;
    }
    if (!dk) {
      const mtime = nodeAt(state, src)?.mtime ?? datasetAtPath(state, src)?.createdAt ?? opts.now;
      state.fs.nodes.push({ path: dst, type: 'DIRECTORY', size: 2, mtime: opts.preserve ? mtime : opts.now, inode: newInode(state) });
      copyMeta();
    }
    let ok = true;
    for (const child of childPaths(state, src)) {
      const target = `${dst}/${basename(child)}`;
      if (opts.oneFileSystem && isMount(state, child)) {
        // `cp -x` creates the mount point directory but does not copy what is mounted there.
        if (!kindAt(state, target)) state.fs.nodes.push({ path: target, type: 'DIRECTORY', size: 2, mtime: opts.now, inode: newInode(state) });
        continue;
      }
      if (!copyEntry(state, child, target, opts, out, usage)) ok = false;
    }
    return ok;
  }
  if (dk) {
    if (opts.noClobber) return true;
    if (dk === 'DIRECTORY') {
      out.push(`cp: cannot overwrite directory '${dst}' with non-directory`);
      return false;
    }
    deleteEntry(state, dst, usage);
  }
  const node = nodeAt(state, src)!;
  state.fs.nodes.push({ ...node, path: dst, mtime: opts.preserve ? node.mtime : opts.now, inode: newInode(state) });
  if (node.type === 'FILE') usage.add(dst, node.size);
  copyMeta();
  return true;
}

export function cpCommand(mock: Mock, args: string[]): CommandResult {
  const { state } = mock;
  return run(CP, mock, args, (parsed, out, usage) => {
    const f = parsed.flags;
    const opts: CopyOptions = {
      noClobber: f.has('no-clobber'),
      preserve: f.has('archive') || f.has('preserve'),
      oneFileSystem: f.has('one-file-system'),
      now: Date.now(),
    };
    const recursive = f.has('archive') || f.has('recursive');
    let ok = true;
    for (const [rawSrc, rawDst] of targetPairs(state, 'cp', parsed)) {
      const fail = (msg: string) => {
        out.push(msg);
        ok = false;
      };
      const src = clean(rawSrc) && resolveParents(state, clean(rawSrc)!);
      const dst = clean(rawDst) && resolveParents(state, clean(rawDst)!);
      const sk = src ? kindAt(state, src) : null;
      if (!src || !sk) {
        fail(`cp: cannot stat '${rawSrc}': No such file or directory`);
        continue;
      }
      if (sk === 'DIRECTORY' && !recursive) {
        fail(`cp: -r not specified; omitting directory '${rawSrc}'`);
        continue;
      }
      if (!dst || kindAt(state, dirname(dst)) !== 'DIRECTORY') {
        fail(`cp: cannot create ${sk === 'DIRECTORY' ? 'directory' : 'regular file'} '${rawDst}': No such file or directory`);
        continue;
      }
      if (dst === src) {
        fail(`cp: '${rawSrc}' and '${rawDst}' are the same file`);
        continue;
      }
      if (sk === 'DIRECTORY' && dst.startsWith(`${src}/`)) {
        fail(`cp: cannot copy a directory, '${rawSrc}', into itself, '${rawDst}'`);
        continue;
      }
      if (!writable(state, dst)) {
        fail(`cp: cannot create ${sk === 'DIRECTORY' ? 'directory' : 'regular file'} '${rawDst}': Permission denied`);
        continue;
      }
      if (!copyEntry(state, src, dst, opts, out, usage)) ok = false;
    }
    return ok;
  });
}

// ---------------------------------------------------------------------------
// rm
// ---------------------------------------------------------------------------

function removeEntry(state: MockState, path: string, oneFileSystem: boolean, out: string[], usage: Usage): boolean {
  if (kindAt(state, path) === 'DIRECTORY') {
    let ok = true;
    for (const child of childPaths(state, path)) {
      if (isMount(state, child) && oneFileSystem) {
        out.push(`rm: skipping '${child}', since it's on a different device`);
        ok = false;
        continue;
      }
      if (!removeEntry(state, child, oneFileSystem, out, usage)) ok = false;
    }
    if (isMount(state, path)) {
      out.push(`rm: cannot remove '${path}': Device or resource busy`);
      return false;
    }
    if (!ok) {
      out.push(`rm: cannot remove '${path}': Directory not empty`);
      return false;
    }
  }
  deleteEntry(state, path, usage);
  return true;
}

/**
 * `rm` on the file tree. Returns null for a path that is not in the tree (the caller may know it in another
 * way, e.g. as an entry of a pool's damaged-file list).
 */
export function rmPath(mock: Mock, rawPath: string, opts: { recursive: boolean; oneFileSystem: boolean }): CommandResult | null {
  const { state } = mock;
  const cleaned = clean(rawPath);
  if (!cleaned) return null;
  const path = resolveParents(state, cleaned);
  const kind = kindAt(state, path);
  if (!kind) return null;
  if (path === '/' || !datasetContaining(state, path)) return { output: `rm: cannot remove '${rawPath}': Permission denied\n`, code: 1 };
  if (kind === 'DIRECTORY' && !opts.recursive) return { output: `rm: cannot remove '${rawPath}': Is a directory\n`, code: 1 };
  if (lockedDatasetFor(state, path)) return { output: `rm: cannot remove '${rawPath}': Device or resource busy\n`, code: 1 };
  const out: string[] = [];
  const usage = new Usage(mock);
  const ok = removeEntry(state, path, opts.oneFileSystem, out, usage);
  usage.flush();
  return { output: out.map((l) => `${l}\n`).join(''), code: ok ? 0 : 1 };
}

/** Parses rm's arguments (shared with the damaged-file handling in `src/host.ts`). */
export function parseRm(args: string[]): { paths: string[]; force: boolean; recursive: boolean; oneFileSystem: boolean } | { error: string } {
  try {
    const parsed = parseCommand(RM, args);
    return {
      paths: parsed.operands,
      force: parsed.flags.has('force'),
      recursive: parsed.flags.has('recursive'),
      oneFileSystem: parsed.flags.has('one-file-system'),
    };
  } catch (err) {
    if (err instanceof UsageError) return { error: err.message };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// File contents
// ---------------------------------------------------------------------------

function sampleBytes(node: FsNode): Buffer {
  return node.sample ? Buffer.from(node.sample, 'base64') : Buffer.alloc(0);
}

/** How many bytes of a new upload to keep, given what the state already holds. */
function sampleCap(state: MockState): number {
  let total = 0;
  for (const n of state.fs.nodes) if (n.sample) total += Math.floor((n.sample.length * 3) / 4);
  return total >= SAMPLE_BUDGET_BYTES ? SMALL_SAMPLE_BYTES : FILE_SAMPLE_BYTES;
}

/** A file's contents: the stored sample, then the sample (or a text line) repeated up to its size. */
function* fileContents(node: FsNode): Generator<Buffer> {
  const sample = sampleBytes(node);
  let left = node.size;
  const head = sample.subarray(0, left);
  if (head.length) {
    yield head;
    left -= head.length;
  }
  if (left <= 0) return;
  const pattern = sample.length ? sample : Buffer.from(`ApexOs demo data: ${basename(node.path)}\n`);
  const block = Buffer.alloc(64 * 1024, pattern);
  // Keep the pattern aligned after the sample so the filler looks continuous.
  const usable = block.subarray(0, Math.floor(block.length / pattern.length) * pattern.length);
  while (left > 0) {
    const chunk = usable.subarray(0, Math.min(left, usable.length));
    yield chunk;
    left -= chunk.length;
  }
}

/** Collects an upload: total size plus the first `cap` bytes. */
class UploadSink {
  size = 0;
  private readonly kept: Buffer[] = [];
  private keptBytes = 0;

  constructor(private readonly cap: number) {}

  write(chunk: Buffer): void {
    this.size += chunk.length;
    if (this.keptBytes < this.cap) {
      const part = Buffer.from(chunk.subarray(0, this.cap - this.keptBytes));
      this.kept.push(part);
      this.keptBytes += part.length;
    }
  }

  get sample(): Buffer {
    return Buffer.concat(this.kept);
  }
}

// ---------------------------------------------------------------------------
// filesystem.put (through POST /_upload)
// ---------------------------------------------------------------------------

function putFile(mock: Mock, params: unknown[], upload: UploadSink, cap: number): boolean {
  const { state } = mock;
  const [rawPath, rawOptions] = params;
  if (typeof rawPath !== 'string' || !rawPath) throw validationError('filesystem.put.path', 'Input should be a valid string');
  const requested = clean(rawPath);
  if (!requested) throw callError('EFAULT', `[Errno 2] No such file or directory: '${rawPath}'`);
  const options = isObj(rawOptions) ? rawOptions : {};
  const now = Date.now();
  if (lockedDatasetFor(state, requested)) {
    throw callError('EINVAL', `Unable to put contents at '${rawPath}' as the path exists on a locked dataset`);
  }
  makeDirs(state, dirname(resolveParents(state, requested)), now);
  // open() follows a symlink in the last component, too.
  const path = resolveAll(state, requested);
  if (!writable(state, path)) throw callError('EFAULT', `[Errno 2] No such file or directory: '${rawPath}'`);
  const kind = kindAt(state, path);
  if (kind === 'DIRECTORY') throw callError('EFAULT', `[Errno 21] Is a directory: '${rawPath}'`);
  const usage = new Usage(mock);
  let node = nodeAt(state, path);
  const incoming = upload.sample;
  if (node && options.append === true) {
    const kept = sampleBytes(node);
    const room = Math.max(0, cap - kept.length);
    // Only extend the sample while it still covers the whole file.
    const sample = kept.length === node.size ? Buffer.concat([kept, incoming.subarray(0, room)]) : kept;
    node.sample = sample.length ? sample.toString('base64') : undefined;
    node.size += upload.size;
    node.mtime = now;
    usage.add(path, upload.size);
  } else {
    if (node) usage.add(path, -node.size);
    else {
      node = { path, type: 'FILE', size: 0, mtime: now, inode: newInode(state) };
      state.fs.nodes.push(node);
    }
    node.size = upload.size;
    node.sample = incoming.length ? incoming.toString('base64') : undefined;
    node.mtime = now;
    usage.add(path, upload.size);
  }
  usage.flush();
  const mode = options.mode;
  if (typeof mode === 'number') {
    // chmod after writing; ZFS refuses it on datasets with aclmode=restricted and a non-trivial ACL.
    if (!effectiveAcl(state, path).trivial) throw callError('EPERM', `[Errno 1] Operation not permitted: '${path}'`);
    const own = state.fs.owners[path];
    state.fs.owners[path] = { uid: own?.uid ?? 0, gid: own?.gid ?? 0, mode };
  }
  return true;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Streaming multipart/form-data reader: never holds more than one network chunk of a part body. */
class PartReader {
  // A virtual CRLF lets the first boundary be matched like all later ones.
  private buf: Buffer = Buffer.from('\r\n');
  private ended = false;
  private readonly it: AsyncIterator<Buffer | string>;
  private readonly delim: Buffer;

  constructor(stream: AsyncIterable<Buffer | string>, boundary: string) {
    this.it = stream[Symbol.asyncIterator]();
    this.delim = Buffer.from(`\r\n--${boundary}`);
  }

  private async fill(): Promise<boolean> {
    if (this.ended) return false;
    const r = await this.it.next();
    if (r.done) {
      this.ended = true;
      return false;
    }
    const chunk = typeof r.value === 'string' ? Buffer.from(r.value) : r.value;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    return true;
  }

  /** Streams the bytes before the next boundary into `sink`; false when the input ended first. */
  async readBody(sink: (chunk: Buffer) => void, max = Infinity): Promise<boolean> {
    let total = 0;
    const emit = (b: Buffer) => {
      if (!b.length) return;
      total += b.length;
      if (total > max) throw new HttpError(400, 'Part is too large');
      sink(b);
    };
    for (;;) {
      const i = this.buf.indexOf(this.delim);
      if (i >= 0) {
        emit(this.buf.subarray(0, i));
        this.buf = this.buf.subarray(i + this.delim.length);
        return true;
      }
      const keep = this.delim.length - 1;
      if (this.buf.length > keep) {
        emit(this.buf.subarray(0, this.buf.length - keep));
        this.buf = Buffer.from(this.buf.subarray(this.buf.length - keep));
      }
      if (!(await this.fill())) {
        emit(this.buf);
        this.buf = Buffer.alloc(0);
        return false;
      }
    }
  }

  /** Reads the headers of the next part; null after the closing boundary or at the end of input. */
  async nextPart(): Promise<{ name: string | null } | null> {
    while (this.buf.length < 2) if (!(await this.fill())) return null;
    if (this.buf.subarray(0, 2).toString('latin1') === '--') return null;
    for (;;) {
      const end = this.buf.indexOf('\r\n\r\n');
      if (end >= 0) {
        const head = this.buf.subarray(0, end).toString('utf8');
        this.buf = this.buf.subarray(end + 4);
        const disposition = head.split('\r\n').find((l) => /^content-disposition:/i.test(l)) ?? '';
        return { name: /\bname="([^"]*)"/i.exec(disposition)?.[1] ?? null };
      }
      if (this.buf.length > 16 * 1024) throw new HttpError(400, 'Part headers are too large');
      if (!(await this.fill())) return null;
    }
  }

  /** Reads and discards everything that is left. */
  async drain(): Promise<void> {
    this.buf = Buffer.alloc(0);
    while (await this.fill()) this.buf = Buffer.alloc(0);
  }
}

/** Who an `/_upload` request authenticates as (API key, token or basic auth), or null. */
function uploadUser(mock: Mock, header: string | undefined): string | null {
  const { state } = mock;
  if (!header) return null;
  let username: string | null = null;
  if (header.startsWith('Bearer ')) {
    const key = state.apiKeys.find((k) => k.key === header.slice(7));
    if (key && !key.revoked && !(key.expires_at && key.expires_at < Date.now())) username = key.username;
  } else if (header.startsWith('Token ')) {
    const token = header.slice(6);
    const t = mock.tokens.get(token);
    if (t && t.expires > Date.now()) {
      if (t.singleUse) mock.tokens.delete(token);
      username = t.username;
    }
  } else if (header.startsWith('Basic ')) {
    const [user, pass] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(/:(.*)/s, 2);
    const u = state.users.find((x) => x.username === user);
    if (u && !u.password_disabled && u.password && u.password === pass) username = u.username;
  }
  const user = username ? state.users.find((u) => u.username === username) : undefined;
  return user && !user.locked ? user.username : null;
}

async function handleUpload(mock: Mock, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let reader: PartReader | undefined;
  const send = (status: number, body: string) => {
    if (!res.headersSent) res.writeHead(status, { 'content-type': 'text/plain', connection: 'close' }).end(body);
    // Discard the rest of the request body (the client usually stops sending once it sees the answer).
    if (reader) void reader.drain().catch(() => undefined);
    else req.resume();
  };
  if (req.method !== 'POST') return send(405, 'Method not allowed');
  const type = req.headers['content-type'] ?? '';
  const match = /^multipart\/form-data\s*;.*\bboundary=(?:"([^"]+)"|([^;\s]+))/i.exec(type);
  if (!match) return send(400, 'Expected multipart/form-data');
  reader = new PartReader(req, match[1] ?? match[2]!);
  let fileStarted = false;
  let jobId: number | null = null;
  try {
    // Preamble up to the first boundary.
    if (!(await reader.readBody(() => undefined, 64 * 1024))) return send(405, 'No part found on payload');
    const first = await reader.nextPart();
    if (!first) return send(405, 'No part found on payload');
    if (first.name !== 'data') return send(405, '"data" part must be the first on payload');
    const raw: Buffer[] = [];
    await reader.readBody((b) => raw.push(Buffer.from(b)), 1024 * 1024);
    let data: { method?: unknown; params?: unknown };
    try {
      data = JSON.parse(Buffer.concat(raw).toString('utf8'));
    } catch (err) {
      return send(400, (err as Error).message);
    }
    if (!data || typeof data !== 'object' || !('method' in data)) return send(422, '');
    const username = uploadUser(mock, req.headers.authorization);
    if (!username) return send(401, 'Unauthorized');
    if (data.method !== 'filesystem.put') return send(422, `[ENOMETHOD] Method ${String(data.method)} does not accept uploads`);
    const user = mock.state.users.find((u) => u.username === username)!;
    if (!userRoles(mock.state, user).includes('FULL_ADMIN')) return send(403, 'Forbidden');
    const filePart = await reader.nextPart();
    if (!filePart || filePart.name !== 'file') return send(405, '"file" not found as second part on payload');
    const params = Array.isArray(data.params) ? data.params : [];
    const cap = sampleCap(mock.state);
    const upload = new UploadSink(cap);
    fileStarted = true;
    const start = () => (jobId ??= mock.server.startJob('filesystem.put', params, async () => putFile(mock, params, upload, cap)));
    let complete = false;
    try {
      complete = await reader.readBody((b) => upload.write(b));
    } finally {
      // Like the middleware: the job reads whatever arrived, even if the client went away mid-file.
      if (!complete) start();
    }
    await reader.drain();
    start();
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ job_id: jobId }));
  } catch (err) {
    if (err instanceof HttpError) return send(err.status, err.message);
    if (fileStarted) return void res.destroy();
    throw err;
  }
}

// ---------------------------------------------------------------------------
// filesystem.get (through core.download)
// ---------------------------------------------------------------------------

function readableFile(state: MockState, raw: unknown): FsNode {
  if (typeof raw !== 'string' || !raw) throw validationError('filesystem.get.path', 'Input should be a valid string');
  const requested = clean(raw);
  const path = requested ? resolveAll(state, requested) : null;
  const node = path && !hiddenByLock(state, path) ? nodeAt(state, path) : undefined;
  if (!node || node.type !== 'FILE') throw callError('EFAULT', `${raw} is not a file`);
  return node;
}

export function registerFiles(mock: Mock): void {
  const { server } = mock;

  // Both methods move file contents through job pipes, so they only work through /_upload and core.download.
  server.job(
    'filesystem.put',
    async () => null,
    () => {
      throw callError('EINVAL', 'filesystem.put needs an input pipe: send the file to POST /_upload');
    },
  );
  server.job(
    'filesystem.get',
    async () => null,
    () => {
      throw callError('EINVAL', 'filesystem.get needs an output pipe: call it through core.download');
    },
  );

  // core.download itself lives in download.ts; file contents stream straight into the /_download response.
  registerStreamingDownload(mock, 'filesystem.get', (args, filename, windowMs) => {
    const params = Array.isArray(args) ? args : [];
    const name = filename || 'download';
    let deliver!: (res: ServerResponse | null) => void;
    const delivered = new Promise<ServerResponse | null>((resolve) => (deliver = resolve));
    const timer = setTimeout(() => deliver(null), windowMs);
    timer.unref();
    const headers = { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${name}"` };
    const jobId = server.startJob('filesystem.get', params, async () => {
      let node: FsNode;
      try {
        node = readableFile(mock.state, params[0]);
      } catch (err) {
        // The output pipe closes with the failed job: the download is an empty 200 response.
        void delivered.then((res) => res?.writeHead(200, headers).end());
        throw err;
      }
      const res = await delivered;
      clearTimeout(timer);
      if (!res) throw callError('EPIPE', '[Errno 32] Broken pipe');
      res.writeHead(200, headers);
      try {
        await pipeline(Readable.from(fileContents(node)), res);
      } catch {
        throw callError('EPIPE', '[Errno 32] Broken pipe');
      }
      return null;
    });
    return { jobId, serve: (res) => deliver(res) };
  });

  server.httpRoute('/_upload', (req, res) => {
    void handleUpload(mock, req, res).catch((err) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' }).end(String((err as Error).message ?? err));
      else res.destroy();
    });
  });
}
