/** Helpers shared by the network settings section and its dialogs. */
import { computed, ref, type Ref } from 'vue';
import type { NetworkInterfaceSettings, NetworkRestoreStep, Task, TaskStarted } from '@apexos/api-types';
import { ApiError } from '../../lib/api.ts';
import { live, waitForTask } from '../../lib/events.ts';

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export function isIPv4(value: string): boolean {
  return IPV4_RE.test(value.trim());
}

function toInt(address: string): number {
  return address.split('.').reduce((n, o) => n * 256 + Number(o), 0);
}

export function inSubnet(ip: string, address: string, prefix: number): boolean {
  if (!isIPv4(ip) || !isIPv4(address)) return false;
  const size = 2 ** (32 - prefix);
  return Math.floor(toInt(ip) / size) === Math.floor(toInt(address) / size);
}

export function maskOf(prefix: number): string {
  const n = 2 ** 32 - 2 ** (32 - prefix);
  return [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join('.');
}

/** Subnet mask choices, most common first. */
export const PREFIX_OPTIONS = [24, 16, 8, 25, 26, 27, 28, 29, 30, 23, 22, 21, 20, 19, 18, 17].map((prefix) => ({
  value: prefix,
  label: `${maskOf(prefix)} (/${prefix})`,
}));

export function speed(mbps: number | null): string {
  if (!mbps) return '';
  return mbps >= 1000 ? `${mbps / 1000} Gbit/s` : `${mbps} Mbit/s`;
}

export function modeLabel(mode: NetworkInterfaceSettings['mode']): string {
  return mode === 'dhcp' ? 'Automatic (DHCP)' : mode === 'static' ? 'Fixed address' : 'Not set up';
}

export function addressList(i: NetworkInterfaceSettings): string {
  return i.liveAddresses.length ? i.liveAddresses.map((a) => `${a.address}/${a.prefix}`).join(', ') : 'None';
}

/** Whether this browser reaches ApexOs through one of the port's addresses (ApexOs runs on the server). */
export function browserUses(i: NetworkInterfaceSettings): boolean {
  const host = window.location.hostname;
  return [...i.liveAddresses, ...i.configuredAddresses].some((a) => a.address === host);
}

/** Where to open ApexOs once the port has a new address (when this browser used the old one). */
export function newApexOsUrl(i: NetworkInterfaceSettings, newAddress: string | null): string | null {
  if (!newAddress || !browserUses(i)) return null;
  const { protocol, port } = window.location;
  return `${protocol}//${newAddress}${port ? `:${port}` : ''}/settings?section=network`;
}

const RESTORE_STEP: NetworkRestoreStep = 'Restoring your previous settings';

/** How a finished network task ended: kept, previous settings restored, or failed. */
export function outcome(task: Task): 'running' | 'saved' | 'restored' | 'failed' {
  if (task.status === 'running') return 'running';
  if (task.status === 'success') return 'saved';
  return task.steps.some((s) => s.name === RESTORE_STEP && s.status === 'success') ? 'restored' : 'failed';
}

/** Field errors from a validation response, plus the overall message. */
export function readError(e: unknown): { message: string; fields: Record<string, string>; code: string } {
  if (e instanceof ApiError) return { message: e.message, fields: e.fields, code: e.code };
  return { message: e instanceof Error ? e.message : String(e), fields: {}, code: 'UNKNOWN' };
}

/**
 * The message to show above the form: the overall error when there are no field errors, or the
 * field errors the form doesn't display right now (so nothing goes unseen).
 */
export function generalMessage(err: { message: string; fields: Record<string, string> }, visible: string[]): string | null {
  const keys = Object.keys(err.fields);
  if (!keys.length) return err.message;
  const hidden = keys.filter((k) => !visible.includes(k)).map((k) => err.fields[k]);
  return hidden.length ? hidden.join(' ') : null;
}

/** Starts a network task and follows it; `task` stays reactive while the dialog shows its progress. */
export function useNetworkTask(): {
  taskId: Ref<string | null>;
  task: Ref<Task | null>;
  start: (request: Promise<TaskStarted>) => Promise<void>;
} {
  const taskId = ref<string | null>(null);
  const task = computed(() => (taskId.value ? (live.tasks[taskId.value] ?? null) : null));
  async function start(request: Promise<TaskStarted>) {
    const { task: started } = await request;
    live.tasks[started.id] ??= started;
    taskId.value = started.id;
    // Keeps polling the server if the live stream drops while the connection changes.
    waitForTask(started.id).catch(() => undefined);
  }
  return { taskId, task, start };
}
