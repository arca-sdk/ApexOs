/**
 * Upload queue. Files go one at a time (progress weighted by bytes) from the browser to ApexOs, which
 * streams them to TrueNAS. The queue lives outside any component, so it keeps going while you browse
 * other pages; it stops when the page is reloaded or closed (the browser warns first).
 *
 * TrueNAS would overwrite existing files silently, so every batch is checked first and the person is
 * asked what to do with names that already exist.
 */
import { computed, reactive } from 'vue';
import type { FileCheckResponse, FileConflictMode, FileEntry, FileEntryType, FileUploadResponse } from '@apexos/api-types';
import { api, ApiError, session } from '../../lib/api.ts';

export type ConflictDecision = 'replace' | 'keep-both' | 'skip';
export type UploadStatus = 'queued' | 'uploading' | 'done' | 'skipped' | 'failed' | 'canceled';

export interface UploadItem {
  id: number;
  batchId: number;
  /** Path below the destination directory ('/'-separated for folder uploads). */
  relName: string;
  size: number;
  loaded: number;
  status: UploadStatus;
  conflict: FileConflictMode;
  error?: string;
  /** Name it was saved under (differs with "keep both"). */
  savedAs?: string;
}

export interface UploadBatch {
  id: number;
  folder: string;
  dir: string;
  label: string;
  items: UploadItem[];
}

export interface ConflictPrompt {
  folder: string;
  dir: string;
  existing: { name: string; type: FileEntryType }[];
  resolve: (decision: ConflictDecision | null) => void;
}

export interface PendingFile {
  file: File;
  relName: string;
}

export const MAX_BATCH_FILES = 10_000;

export const uploads = reactive({
  batches: [] as UploadBatch[],
  prompt: null as ConflictPrompt | null,
  /** Set from GET /api/files. */
  maxBytes: Number.POSITIVE_INFINITY,
});

const files = new Map<number, File>();
const requests = new Map<number, XMLHttpRequest>();
let nextId = 1;
let pumping = false;

type Listener = (folder: string, dir: string) => void;
const listeners = new Set<Listener>();

/** Called whenever an upload into `folder`/`dir` finished (so a listing can refresh). Returns an unsubscribe function. */
export function onUploaded(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(folder: string, dir: string): void {
  for (const l of listeners) l(folder, dir);
}

const active = (i: UploadItem) => i.status === 'queued' || i.status === 'uploading';

export const uploadSummary = computed(() => {
  const items = uploads.batches.flatMap((b) => b.items);
  const open = items.filter(active);
  const inFlight = uploads.batches.filter((b) => b.items.some(active)).flatMap((b) => b.items.filter((i) => i.status !== 'skipped' && i.status !== 'canceled'));
  const total = inFlight.reduce((s, i) => s + i.size, 0);
  const loaded = inFlight.reduce((s, i) => s + (i.status === 'done' || i.status === 'failed' ? i.size : i.loaded), 0);
  return {
    remaining: open.length,
    failed: items.filter((i) => i.status === 'failed').length,
    percent: total ? Math.round((loaded / total) * 100) : open.length ? 0 : 100,
    busy: open.length > 0,
  };
});

function warnBeforeLeaving(e: BeforeUnloadEvent): void {
  if (!uploadSummary.value.busy) return;
  e.preventDefault();
}
window.addEventListener('beforeunload', warnBeforeLeaving);

function firstSegment(relName: string): string {
  const i = relName.indexOf('/');
  return i < 0 ? relName : relName.slice(0, i);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function checkExisting(folder: string, dir: string, names: string[]): Promise<FileCheckResponse> {
  const out: FileCheckResponse = { existing: [], invalid: [] };
  for (let i = 0; i < names.length; i += 1000) {
    const res = await api.post<FileCheckResponse>('/files/check', { folder, path: dir, names: names.slice(i, i + 1000) });
    out.existing.push(...res.existing);
    out.invalid.push(...res.invalid);
  }
  return out;
}

function askAboutConflicts(folder: string, dir: string, existing: ConflictPrompt['existing']): Promise<ConflictDecision | null> {
  return new Promise((resolve) => {
    uploads.prompt = {
      folder,
      dir,
      existing,
      resolve: (decision) => {
        uploads.prompt = null;
        resolve(decision);
      },
    };
  });
}

/**
 * Queues files (and empty folders, from drag and drop) for upload into `folder`/`dir`.
 * Resolves once the batch is queued; throws if it can't be (e.g. too many files).
 */
export async function queueUpload(folder: string, dir: string, pending: PendingFile[], emptyDirs: string[] = []): Promise<void> {
  if (!pending.length && !emptyDirs.length) return;
  if (pending.length > MAX_BATCH_FILES) throw new Error(`Upload at most ${MAX_BATCH_FILES.toLocaleString()} files at a time.`);
  const tops = [...new Set([...pending.map((p) => firstSegment(p.relName)), ...emptyDirs.map(firstSegment)])];
  const check = await checkExisting(folder, dir, tops);
  const invalid = new Map(check.invalid.map((i) => [i.name, i.reason]));
  const conflicts = new Map(check.existing.map((e) => [e.name, e.type]));
  let decision: ConflictDecision | null = null;
  if (conflicts.size) {
    decision = await askAboutConflicts(folder, dir, check.existing);
    if (!decision) return;
  }
  // "Keep both" for a folder: create the numbered folder once and upload everything into it.
  const renamedTops = new Map<string, string>();
  if (decision === 'keep-both') {
    for (const [name, type] of conflicts) {
      if (type !== 'folder') continue;
      const made = await api.post<FileEntry>('/files/mkdir', { folder, path: dir, name, conflict: 'keep-both' });
      renamedTops.set(name, made.name);
    }
  }
  const rename = (relName: string) => {
    const top = firstSegment(relName);
    const renamed = renamedTops.get(top);
    return renamed ? renamed + relName.slice(top.length) : relName;
  };
  for (const d of emptyDirs) {
    const top = firstSegment(d);
    if (invalid.has(top) || (conflicts.has(top) && decision === 'skip')) continue;
    await api.post('/files/mkdir', { folder, path: dir, name: rename(d), parents: true, conflict: 'skip' }).catch(() => undefined);
  }

  const batchId = nextId++;
  const items: UploadItem[] = pending.map((p) => {
    const top = firstSegment(p.relName);
    const item: UploadItem = { id: nextId++, batchId, relName: rename(p.relName), size: p.file.size, loaded: 0, status: 'queued', conflict: 'ask' };
    files.set(item.id, p.file);
    if (invalid.has(top)) Object.assign(item, { status: 'failed', error: invalid.get(top) });
    else if (p.file.size > uploads.maxBytes) Object.assign(item, { status: 'failed', error: 'Larger than the upload limit' });
    else if (conflicts.has(top)) {
      if (decision === 'skip') item.status = 'skipped';
      else if (decision === 'keep-both') item.conflict = renamedTops.has(top) ? 'ask' : 'keep-both';
      // Replacing a folder adds to it and replaces files with the same names.
      else item.conflict = 'replace';
    }
    if (item.status !== 'queued') files.delete(item.id);
    return item;
  });
  const folders = new Set(pending.filter((p) => p.relName.includes('/')).map((p) => firstSegment(p.relName)));
  const label =
    folders.size === 1 && pending.every((p) => p.relName.includes('/'))
      ? `“${rename([...folders][0]!)}”`
      : pending.length === 1
        ? `“${pending[0]!.relName}”`
        : `${pending.length.toLocaleString()} files`;
  uploads.batches.push({ id: batchId, folder, dir, label, items });
  if (emptyDirs.length && !pending.length) notify(folder, dir);
  void pump();
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const batch = uploads.batches.find((b) => b.items.some((i) => i.status === 'queued'));
      if (!batch) break;
      const item = batch.items.find((i) => i.status === 'queued')!;
      await send(batch, item);
      notify(batch.folder, batch.dir);
    }
  } finally {
    pumping = false;
  }
}

function send(batch: UploadBatch, item: UploadItem): Promise<void> {
  const file = files.get(item.id);
  if (!file) {
    item.status = 'failed';
    item.error = 'The file is no longer available';
    return Promise.resolve();
  }
  item.status = 'uploading';
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    requests.set(item.id, xhr);
    const finish = (status: UploadStatus, error?: string) => {
      item.status = status;
      if (error) item.error = error;
      if (status === 'done') item.loaded = item.size;
      requests.delete(item.id);
      files.delete(item.id);
      resolve();
    };
    const query = new URLSearchParams({ folder: batch.folder, path: batch.dir, name: item.relName, conflict: item.conflict });
    xhr.open('POST', `/api/files/upload?${query}`);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      item.loaded = Math.min(e.loaded, item.size);
    };
    xhr.onload = () => {
      let body: (FileUploadResponse & { error?: { message?: string; code?: string } }) | null = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = null;
      }
      if (xhr.status >= 200 && xhr.status < 300 && body?.entry) {
        item.savedAs = body.entry.name;
        finish(body.action === 'skipped' ? 'skipped' : 'done');
      } else {
        if (xhr.status === 401) session.authenticated = false;
        const message = body?.error?.message ?? `Upload failed (${xhr.status})`;
        finish('failed', body?.error?.code === 'CONFLICT' ? 'Something with this name appeared meanwhile; nothing was replaced' : message);
      }
    };
    xhr.onerror = () => finish('failed', 'The connection to ApexOs was interrupted');
    xhr.onabort = () => finish('canceled');
    xhr.send(file);
  });
}

export function cancelItem(item: UploadItem): void {
  if (item.status === 'queued') {
    item.status = 'canceled';
    files.delete(item.id);
  } else if (item.status === 'uploading') requests.get(item.id)?.abort();
}

export function cancelBatch(batch: UploadBatch): void {
  for (const item of batch.items) cancelItem(item);
}

export function cancelAll(): void {
  for (const b of uploads.batches) cancelBatch(b);
}

/** Retries failed items of a batch (they will ask again if the name is taken by then). */
export function retryFailed(batch: UploadBatch): void {
  for (const item of batch.items) {
    if (item.status === 'failed' && files.has(item.id)) Object.assign(item, { status: 'queued', loaded: 0, error: undefined });
  }
  void pump();
}

export function clearFinished(): void {
  uploads.batches = uploads.batches.filter((b) => b.items.some(active));
}

export function batchStats(batch: UploadBatch) {
  const count = (s: UploadStatus) => batch.items.filter((i) => i.status === s).length;
  const counted = batch.items.filter((i) => i.status !== 'skipped' && i.status !== 'canceled');
  const total = counted.reduce((s, i) => s + i.size, 0);
  const loaded = counted.reduce((s, i) => s + (i.status === 'done' || i.status === 'failed' ? i.size : i.loaded), 0);
  return {
    done: count('done'),
    skipped: count('skipped'),
    failed: count('failed'),
    canceled: count('canceled'),
    open: batch.items.filter(active).length,
    percent: total ? Math.round((loaded / total) * 100) : 100,
    destination: [batch.folder.split('/').pop() ?? batch.folder, ...(batch.dir ? batch.dir.split('/') : [])].join('/'),
  };
}

/** Collects files and folders (including empty ones) from a drag-and-drop from the computer. */
export async function filesFromDrop(data: DataTransfer): Promise<{ files: PendingFile[]; emptyDirs: string[] }> {
  const entries = [...data.items].map((i) => (i.kind === 'file' ? i.webkitGetAsEntry?.() : null)).filter((e): e is FileSystemEntry => !!e);
  if (!entries.length) return { files: [...data.files].map((file) => ({ file, relName: file.name })), emptyDirs: [] };
  const out: PendingFile[] = [];
  const emptyDirs: string[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      out.push({ file, relName: rel });
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const children: FileSystemEntry[] = [];
    // readEntries returns results in chunks until it returns an empty list.
    for (;;) {
      const chunk = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      if (!chunk.length) break;
      children.push(...chunk);
      if (out.length + children.length > MAX_BATCH_FILES) throw new Error(`Upload at most ${MAX_BATCH_FILES.toLocaleString()} files at a time.`);
    }
    if (!children.length) emptyDirs.push(rel);
    for (const child of children) await walk(child, rel);
  };
  for (const e of entries) await walk(e, '');
  return { files: out, emptyDirs };
}

/** Files picked with a folder chooser keep their path below the chosen folder. */
export function filesFromInput(list: FileList): PendingFile[] {
  return [...list].map((file) => ({ file, relName: file.webkitRelativePath || file.name }));
}

export function uploadErrorText(err: unknown): string {
  return err instanceof ApiError ? err.message : errorText(err);
}
