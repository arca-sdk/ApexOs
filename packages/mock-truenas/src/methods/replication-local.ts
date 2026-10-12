/**
 * `replication.run_onetime` with `transport: "LOCAL"` (a zettarepl send/receive on the same box), the part of
 * replication ApexOs uses to encrypt an existing folder: a non-raw send of an unencrypted dataset tree into a
 * new target received with `-o encryption=on`, which becomes a new encryption root (children inherit).
 *
 * Kept self-contained on purpose: `validateLocalOnetime` + `runLocalReplication` are the LOCAL branch and
 * `registerLocalReplication` registers the method with a transport dispatch, so SSH transports can be added
 * next to it. Follows middleware `plugins/replication.py` (`_validate`) and zettarepl `replication/run.py`.
 *
 * Simulated: snapshot selection by `name_regex` / `also_include_naming_schema`, full and incremental sends,
 * `only_from_scratch` / `allow_from_scratch`, `properties` (+ `_override` / `_exclude`), `readonly`,
 * `retention_policy` SOURCE/NONE, encryption on receive with `encryption_key_location: "$TrueNAS"` storing a
 * HEX key under the *target* name, and the left-behind `keylocation=file:///tmp/zettarepl-key-…`.
 * Encrypted data takes ~1% more space than the source.
 */
import { randomBytes } from 'node:crypto';
import type { Mock } from '../context.ts';
import { encryptionRootOf, isEncrypted, isLocked, newEncryption, storeKey } from '../encryption.ts';
import { callError, validationErrors, type JobControl } from '../rpc.ts';
import type { DatasetState, SnapshotState } from '../state.ts';
import { addDataset, datasetContaining, descendants, getDataset, INHERITABLE_PROPS, mountpoint, parentId, removeDatasetTree, renderDataset, renderSnapshot, sortDatasets } from '../storage.ts';
import { argObj, GiB, isObj, type Obj } from '../util.ts';

/** Space an encrypted copy takes compared to the plain source (per-block overhead). */
export const ENCRYPTION_OVERHEAD = 1.01;

interface LocalOnetime {
  sourceDatasets: string[];
  target: string;
  recursive: boolean;
  exclude: string[];
  properties: boolean;
  propertiesExclude: string[];
  propertiesOverride: Record<string, string>;
  nameRegex: RegExp | null;
  namingSchemas: RegExp[];
  retention: 'SOURCE' | 'NONE' | 'CUSTOM';
  readonly: 'SET' | 'REQUIRE' | 'IGNORE';
  allowFromScratch: boolean;
  onlyFromScratch: boolean;
  encryption: null | { inherit: boolean; keyFormat: 'HEX' | 'PASSPHRASE' | null; key: string | null; location: string | null };
}

const ATTR = 'replication_run_onetime';

/** strftime-style naming schema (`auto-%Y-%m-%d_%H-%M`) as a regex. */
function schemaRegex(schema: string): RegExp {
  const parts: Record<string, string> = { Y: '\\d{4}', y: '\\d{2}', m: '\\d{2}', d: '\\d{2}', H: '\\d{2}', M: '\\d{2}', S: '\\d{2}', z: '[+-]\\d{4}', s: '\\d+' };
  let out = '';
  for (let i = 0; i < schema.length; i++) {
    const c = schema[i]!;
    if (c === '%' && i + 1 < schema.length) {
      const k = schema[++i]!;
      out += k === '%' ? '%' : (parts[k] ?? '.+');
    } else out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** Middleware-side validation of a LOCAL push (`replication._validate` plus the pydantic model). */
export function validateLocalOnetime(data: Obj): LocalOnetime {
  const errors: Array<[string, string]> = [];
  for (const k of ['direction', 'transport', 'source_datasets', 'target_dataset', 'recursive', 'retention_policy']) {
    if (data[k] === undefined || data[k] === null) errors.push([`${ATTR}.${k}`, 'Field required']);
  }
  if (data.direction !== undefined && data.direction !== 'PUSH' && data.direction !== 'PULL') errors.push([`${ATTR}.direction`, "Input should be 'PUSH' or 'PULL'"]);
  const sources = Array.isArray(data.source_datasets) ? data.source_datasets : [];
  if (data.source_datasets !== undefined && (!Array.isArray(data.source_datasets) || !sources.length || sources.some((s) => typeof s !== 'string' || !s))) {
    errors.push([`${ATTR}.source_datasets`, 'List should have at least 1 item after validation']);
  }
  if (data.target_dataset !== undefined && (typeof data.target_dataset !== 'string' || !data.target_dataset)) errors.push([`${ATTR}.target_dataset`, 'Input should be a valid string']);
  const retention = data.retention_policy ?? 'NONE';
  if (!['SOURCE', 'CUSTOM', 'NONE'].includes(String(retention))) errors.push([`${ATTR}.retention_policy`, "Input should be 'SOURCE', 'CUSTOM' or 'NONE'"]);
  const readonly = data.readonly ?? 'SET';
  if (!['SET', 'REQUIRE', 'IGNORE'].includes(String(readonly))) errors.push([`${ATTR}.readonly`, "Input should be 'SET', 'REQUIRE' or 'IGNORE'"]);

  const nameRegex = typeof data.name_regex === 'string' && data.name_regex ? data.name_regex : null;
  const alsoInclude = Array.isArray(data.also_include_naming_schema) ? (data.also_include_naming_schema as unknown[]).filter((s): s is string => typeof s === 'string') : [];
  const periodic = Array.isArray(data.periodic_snapshot_tasks) ? data.periodic_snapshot_tasks : [];
  if (data.direction === 'PUSH') {
    if (Array.isArray(data.naming_schema) && data.naming_schema.length) errors.push([`${ATTR}.naming_schema`, 'This field has no sense for push replication']);
    if (!periodic.length && !alsoInclude.length && !nameRegex) {
      errors.push([
        `${ATTR}.periodic_snapshot_tasks`,
        'You must at least either bind a periodic snapshot task or provide "Also Include Naming Schema" or "Name Regex" for push replication task',
      ]);
    }
  }
  if (data.transport === 'LOCAL') {
    if (data.ssh_credentials !== undefined && data.ssh_credentials !== null) errors.push([`${ATTR}.ssh_credentials`, 'Remote credentials have no sense for local replication']);
    if (data.compression !== undefined && data.compression !== null) errors.push([`${ATTR}.compression`, 'Compression has no sense for local replication']);
    if (data.speed_limit !== undefined && data.speed_limit !== null) errors.push([`${ATTR}.speed_limit`, 'Speed limit has no sense for local replication']);
  }
  const exclude = Array.isArray(data.exclude) ? (data.exclude as unknown[]).filter((e): e is string => typeof e === 'string') : [];
  if (data.recursive !== true && exclude.length) errors.push([`${ATTR}.exclude`, 'Excluding child datasets is only supported for recursive replication']);
  exclude.forEach((e, i) => {
    if (!sources.some((s) => typeof s === 'string' && e.startsWith(`${s}/`))) errors.push([`${ATTR}.exclude.${i}`, 'This dataset is not a child of any of source datasets']);
  });
  if (data.replicate === true) errors.push([`${ATTR}.replicate`, 'Full filesystem replication is not simulated']);

  let encryption: LocalOnetime['encryption'] = null;
  if (data.encryption === true) {
    const inherit = data.encryption_inherit === true;
    if (!inherit) {
      for (const k of ['encryption_key', 'encryption_key_format', 'encryption_key_location']) {
        if (data[k] === undefined || data[k] === null) errors.push([`${ATTR}.${k}`, 'This property is required when remote dataset encryption is enabled']);
      }
    }
    const format = data.encryption_key_format ?? null;
    if (format !== null && format !== 'HEX' && format !== 'PASSPHRASE') errors.push([`${ATTR}.encryption_key_format`, "Input should be 'HEX' or 'PASSPHRASE'"]);
    const key = typeof data.encryption_key === 'string' ? data.encryption_key : null;
    if (format === 'HEX' && key !== null && !/^[0-9a-fA-F]{64}$/.test(key)) errors.push([`${ATTR}.encryption_key`, 'Key must be 64 hexadecimal characters']);
    if (format === 'PASSPHRASE' && key !== null && key.length < 8) errors.push([`${ATTR}.encryption_key`, 'Passphrase must be at least 8 characters']);
    encryption = { inherit, keyFormat: format as 'HEX' | 'PASSPHRASE' | null, key, location: typeof data.encryption_key_location === 'string' ? data.encryption_key_location : null };
  }

  let regex: RegExp | null = null;
  if (nameRegex) {
    try {
      regex = new RegExp(`^(?:${nameRegex})$`);
    } catch (e) {
      errors.push([`${ATTR}.name_regex`, `Invalid regex: ${(e as Error).message}`]);
    }
    if (alsoInclude.length) errors.push([`${ATTR}.name_regex`, 'Naming regex can\'t be used with Naming schema']);
    if (retention !== 'SOURCE' && retention !== 'NONE') errors.push([`${ATTR}.retention_policy`, 'Only `Same as Source` and `None` retention policies can be used with Naming regex']);
  }
  const override = isObj(data.properties_override) ? data.properties_override : {};
  for (const [k, v] of Object.entries(override)) if (typeof v !== 'string') errors.push([`${ATTR}.properties_override.${k}`, 'Input should be a valid string']);
  if (errors.length) throw validationErrors(errors);

  return {
    sourceDatasets: sources as string[],
    target: data.target_dataset as string,
    recursive: data.recursive === true,
    exclude,
    properties: data.properties !== false,
    propertiesExclude: Array.isArray(data.properties_exclude) ? (data.properties_exclude as unknown[]).filter((e): e is string => typeof e === 'string') : [],
    propertiesOverride: override as Record<string, string>,
    nameRegex: regex,
    namingSchemas: alsoInclude.map(schemaRegex),
    retention: retention as LocalOnetime['retention'],
    readonly: readonly as LocalOnetime['readonly'],
    allowFromScratch: data.allow_from_scratch === true,
    onlyFromScratch: data.only_from_scratch === true,
    encryption,
  };
}

class ReplicationError extends Error {}

function snapshotsOf(mock: Mock, dataset: string): SnapshotState[] {
  return mock.state.snapshots.filter((s) => s.dataset === dataset).sort((a, b) => a.createtxg - b.createtxg);
}

/** Copies the files, owners and ACLs that live directly in `src` (not in child datasets) to `dst`. */
function copyContents(mock: Mock, src: DatasetState, dst: DatasetState): void {
  const { state } = mock;
  const from = mountpoint(src);
  const to = mountpoint(dst);
  const own = (p: string) => (p === from || p.startsWith(`${from}/`)) && datasetContaining(state, p)?.id === src.id;
  const map = (p: string) => `${to}${p.slice(from.length)}`;
  const mine = (p: string) => (p === to || p.startsWith(`${to}/`)) && datasetContaining(state, p)?.id === dst.id;
  state.fs.nodes = state.fs.nodes.filter((n) => !mine(n.path));
  for (const k of Object.keys(state.fs.acls)) if (mine(k)) delete state.fs.acls[k];
  for (const k of Object.keys(state.fs.owners)) if (mine(k)) delete state.fs.owners[k];
  for (const n of state.fs.nodes.filter((x) => own(x.path))) state.fs.nodes.push({ ...n, path: map(n.path) });
  for (const [p, acl] of Object.entries(state.fs.acls)) if (own(p)) state.fs.acls[map(p)] = structuredClone(acl);
  for (const [p, o] of Object.entries(state.fs.owners)) if (own(p)) state.fs.owners[map(p)] = { ...o };
}

function receivedProps(job: LocalOnetime, src: DatasetState): Pick<DatasetState, 'props' | 'quota' | 'refquota' | 'user_properties' | 'comments' | 'share_type'> {
  if (!job.properties) return { props: {}, quota: null, refquota: null, user_properties: {}, comments: '', share_type: 'GENERIC' };
  const skip = new Set(job.propertiesExclude.map((p) => p.toLowerCase()));
  const props = Object.fromEntries(Object.entries(src.props).filter(([k]) => !skip.has(k)));
  const user = Object.fromEntries(Object.entries(src.user_properties).filter(([k]) => !skip.has(k)));
  let quota = skip.has('quota') ? null : src.quota;
  let refquota = skip.has('refquota') ? null : src.refquota;
  for (const [k, v] of Object.entries(job.propertiesOverride)) {
    const key = k.toLowerCase();
    if (key === 'quota' || key === 'refquota') {
      const n = v.toLowerCase() === 'none' ? null : Number(v) || null;
      if (key === 'quota') quota = n;
      else refquota = n;
    } else if (INHERITABLE_PROPS.includes(key)) props[key] = v.toUpperCase();
    else if (k.includes(':')) user[k] = v;
  }
  return { props, quota, refquota, user_properties: user, comments: src.comments, share_type: src.share_type };
}

/** zettarepl's PUSH over LOCAL for one source dataset tree. */
async function replicateTree(mock: Mock, job: JobControl, task: LocalOnetime, source: string, target: string, log: (line: string) => void): Promise<void> {
  const { state } = mock;
  const src = getDataset(state, source);
  if (!src) throw new ReplicationError(`Dataset '${source}' does not exist`);
  const tree = sortDatasets([src, ...(task.recursive ? descendants(state, source) : [])]).filter(
    (d) => !task.exclude.some((e) => d.id === e || d.id.startsWith(`${e}/`)),
  );
  const existing = getDataset(state, target);
  if (existing && task.onlyFromScratch) throw new ReplicationError(`Target dataset '${target}' already exists`);
  if (existing && existing.type !== src.type) {
    throw new ReplicationError(`Source '${source}' is a ${src.type.toLowerCase()}, but target '${target}' already exists and is a ${existing.type.toLowerCase()}`);
  }
  if (task.encryption && task.properties) {
    const enc = tree.find((d) => isEncrypted(state, d));
    if (enc) throw new ReplicationError(`Re-encrypting already encrypted source dataset '${enc.id}' while preserving its properties is not supported`);
  }
  const lockedSrc = tree.find((d) => isLocked(state, d));
  if (lockedSrc) throw new ReplicationError(`cannot send '${lockedSrc.id}': encryption key not loaded`);
  const targetParent = parentId(target);
  if (!existing) {
    const parent = targetParent ? getDataset(state, targetParent) : undefined;
    if (task.encryption?.inherit && !(parent && isEncrypted(state, parent))) {
      throw new ReplicationError(`Encryption inheritance requested for destination dataset '${target}', but its existing parent is not encrypted.`);
    }
    if (!task.encryption && parent && isEncrypted(state, parent) && !isEncrypted(state, src)) {
      throw new ReplicationError(
        `Destination dataset '${target}' must be encrypted (as one of its ancestors is encrypted). Refusing to transfer unencrypted source dataset '${source}'. Please, set up replication task encryption in order to replicate this dataset.`,
      );
    }
    if (parent && isLocked(state, parent)) throw new ReplicationError(`cannot receive new filesystem stream: '${targetParent}' is locked`);
  } else if (task.encryption && !isEncrypted(state, existing)) {
    throw new ReplicationError(`Encryption requested for destination dataset '${target}', but it already exists and is not encrypted.`);
  }

  const matches = (name: string) => (task.nameRegex?.test(name) ?? false) || task.namingSchemas.some((r) => r.test(name));
  const steps: Array<{ src: DatasetState; dst: string; base: SnapshotState | null; send: SnapshotState[] }> = [];
  for (const ds of tree) {
    const dst = `${target}${ds.id.slice(source.length)}`;
    const srcSnaps = snapshotsOf(mock, ds.id).filter((s) => matches(s.name));
    let dstSnaps = getDataset(state, dst) ? snapshotsOf(mock, dst) : [];
    const srcNames = new Set(srcSnaps.map((s) => s.name));
    const baseName = [...dstSnaps].reverse().find((s) => srcNames.has(s.name))?.name ?? null;
    const base = baseName ? srcSnaps.find((s) => s.name === baseName)! : null;
    let send = base ? srcSnaps.filter((s) => s.createtxg > base.createtxg) : srcSnaps;
    if (!base && send.length && getDataset(state, dst)) {
      if (dstSnaps.length) {
        if (!task.allowFromScratch) throw new ReplicationError(`No incremental base on dataset '${ds.id}' and replication from scratch is not allowed`);
        log(`[replication] No incremental base for dataset '${ds.id}', destroying destination dataset`);
        removeDatasetTree(mock, dst);
        dstSnaps = [];
      } else if (!task.allowFromScratch && state.fs.nodes.some((n) => n.path.startsWith(`${mountpoint({ id: dst, pool: ds.pool })}/`))) {
        throw new ReplicationError(
          `Target dataset '${dst}' does not have snapshots but has data and replication from scratch is not allowed. Refusing to overwrite existing data.`,
        );
      }
    }
    if (!send.length) {
      if (ds === src && !base) throw new ReplicationError(`Dataset '${ds.id}' does not have any matching snapshots to replicate`);
      send = [];
    }
    steps.push({ src: ds, dst, base, send });
  }

  const total = steps.reduce((n, s) => n + s.send.length, 0) || 1;
  let done = 0;
  for (const step of steps) {
    if (!step.send.length) continue;
    let dst = getDataset(state, step.dst);
    const encrypted = !!task.encryption || (!!targetParent && !!getDataset(state, targetParent) && isEncrypted(state, getDataset(state, targetParent)!));
    const size = Math.ceil(step.src.usedBytes * (encrypted ? ENCRYPTION_OVERHEAD : 1));
    if (!dst) {
      const recv = receivedProps(task, step.src);
      let encryption;
      if (step.src === src && task.encryption && !task.encryption.inherit) {
        const keyFormat = task.encryption.keyFormat ?? 'HEX';
        const secret = keyFormat === 'HEX' ? task.encryption.key!.toLowerCase() : task.encryption.key!;
        const location = task.encryption.location === '$TrueNAS' ? `file:///tmp/zettarepl-key-${randomBytes(4).toString('hex')}` : (task.encryption.location ?? 'prompt');
        encryption = newEncryption(keyFormat, secret, { keylocation: location });
      }
      dst = addDataset(mock, { id: step.dst, type: step.src.type, usedBytes: size, ...recv, encryption }, false);
      dst.props = recv.props;
      if (encryption && task.encryption?.location === '$TrueNAS') {
        // zettarepl calls pool.dataset.insert_or_update_encrypted_record for HEX keys after receiving.
        storeKey(state, step.dst, encryption.keyFormat, encryption.secret);
      }
      mock.emit('pool.dataset.query', 'added', dst.id, renderDataset(state, dst));
    } else {
      dst.usedBytes = size;
    }
    for (const snap of step.send) {
      job.progress(Math.min(99, Math.round((done / total) * 100)), `Sending ${snap.id} (${done + 1}/${total})`);
      log(`[replication] Sending ${snap.id} to ${step.dst}@${snap.name}${step.base || done ? ' (incremental)' : ' (full)'}`);
      // Simulated transfer time: one step per 100 GiB, at least three (setting up the stream).
      await job.sleep(Math.min(12, Math.max(3, Math.ceil(snap.referenced / (100 * GiB)))));
      const copy: SnapshotState = {
        id: `${step.dst}@${snap.name}`,
        dataset: step.dst,
        name: snap.name,
        createtxg: mock.nextTxg(),
        createdAt: snap.createdAt,
        referenced: Math.ceil(snap.referenced * (encrypted ? ENCRYPTION_OVERHEAD : 1)),
        usedBytes: Math.ceil(snap.usedBytes * (encrypted ? ENCRYPTION_OVERHEAD : 1)),
      };
      state.snapshots = state.snapshots.filter((s) => s.id !== copy.id);
      state.snapshots.push(copy);
      mock.emit('pool.snapshot.query', 'added', copy.id, renderSnapshot(state, copy));
      done++;
    }
    copyContents(mock, step.src, dst);
    if (task.retention === 'SOURCE') {
      const keep = new Set(snapshotsOf(mock, step.src.id).map((s) => s.name));
      for (const s of snapshotsOf(mock, step.dst).filter((x) => !keep.has(x.name))) {
        state.snapshots = state.snapshots.filter((x) => x !== s);
        mock.emit('pool.snapshot.query', 'removed', s.id);
      }
    }
    if (step.src === src) {
      if (task.readonly === 'REQUIRE' && dst.props.readonly !== 'ON') {
        throw new ReplicationError(`Target dataset '${dst.id}' exists and does not have readonly=on property, but replication task is set up to require this property.`);
      }
      if (task.readonly === 'SET') dst.props.readonly = 'ON';
    }
    mock.emit('pool.dataset.query', 'changed', dst.id, renderDataset(state, dst));
  }
  const root = getDataset(state, target);
  if (root) log(`[replication] Finished replicating ${source} to ${target}${encryptionRootOf(state, root)?.id === target ? ' (new encryption root)' : ''}`);
}

/** Runs a validated LOCAL push replication as the `replication.run_onetime` job. */
export async function runLocalReplication(mock: Mock, task: LocalOnetime, job: JobControl): Promise<null> {
  const log = (line: string) => job.log(`${new Date().toISOString()} ${line}\n`);
  job.progress(0, 'Starting replication');
  try {
    for (const source of task.sourceDatasets) {
      const target = task.sourceDatasets.length === 1 ? task.target : `${task.target}/${source.split('/').pop()}`;
      await replicateTree(mock, job, task, source, target, log);
    }
  } catch (e) {
    if (e instanceof ReplicationError) {
      log(`[replication] Error: ${e.message}`);
      throw callError('EFAULT', e.message);
    }
    throw e;
  }
  job.progress(100, 'Replication finished');
  return null;
}

/**
 * Registers `replication.run_onetime`. Argument shape errors (pydantic) come back from the call itself; the
 * middleware's `_validate` checks and replication errors fail the job, as on a real server.
 */
export function registerLocalReplication(mock: Mock): void {
  mock.server.job(
    'replication.run_onetime',
    async (p, job) => runLocalReplication(mock, validateLocalOnetime(argObj(p[0], ATTR)), job),
    (p) => {
      const data = argObj(p[0], ATTR);
      const errors: Array<[string, string]> = [];
      for (const k of ['direction', 'transport', 'source_datasets', 'target_dataset', 'recursive', 'retention_policy']) {
        if (data[k] === undefined || data[k] === null) errors.push([`${ATTR}.${k}`, 'Field required']);
      }
      if (data.transport !== undefined && !['SSH', 'SSH+NETCAT', 'LOCAL'].includes(String(data.transport))) {
        errors.push([`${ATTR}.transport`, "Input should be 'SSH', 'SSH+NETCAT' or 'LOCAL'"]);
      }
      if (errors.length) throw validationErrors(errors);
      if (data.transport !== 'LOCAL') throw callError('ENOTSUP', `replication.run_onetime: transport ${String(data.transport)} is not simulated (only LOCAL)`);
      if (data.direction === 'PULL') throw callError('ENOTSUP', 'replication.run_onetime: PULL over LOCAL is not simulated; use PUSH');
    },
  );
}
