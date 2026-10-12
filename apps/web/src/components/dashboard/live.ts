import { computed } from 'vue';
import type { MetricsSample } from '@apexos/api-types';
import { metrics } from '../../lib/events.ts';

/** Most recent live sample, or null until the first one arrives. */
export const latest = computed<MetricsSample | null>(() => metrics.value.at(-1) ?? null);
export const sampleTimes = computed(() => metrics.value.map((m) => m.time));

/** One number per sample, oldest first. */
export function seriesOf(pick: (m: MetricsSample) => number) {
  return computed(() => metrics.value.map(pick));
}

const VIRTUAL = /^(lo|veth|docker|br-|vnet|tap|kube|cni|flannel|virbr|tun|wg|tailscale|incus|lxc)/;

/** Physical-looking network interfaces (falls back to every interface if none match). */
export function visibleInterfaces(sample: MetricsSample | null): MetricsSample['network'] {
  const all = sample?.network ?? [];
  const physical = all.filter((n) => !VIRTUAL.test(n.name));
  return (physical.length ? physical : all).slice().sort((a, b) => Number(b.up) - Number(a.up) || a.name.localeCompare(b.name));
}

export function formatLinkSpeed(mbps: number | null): string {
  if (!mbps) return 'Speed unknown';
  return mbps >= 1000 ? `${(mbps / 1000).toString().replace(/\.0$/, '')} Gb/s` : `${mbps} Mb/s`;
}

/** Splits memory into what services use, what the ZFS cache holds, and what is free. */
export function memoryBreakdown(m: MetricsSample['memory']) {
  const total = m.totalBytes || 1;
  const cache = Math.min(m.cacheBytes, m.usedBytes);
  const services = Math.max(0, m.usedBytes - cache);
  const free = Math.max(0, total - services - cache);
  return { total, services, cache, free };
}

export function temperatureTone(c: number | null | undefined): '' | 'warn' | 'err' {
  if (c === null || c === undefined) return '';
  return c >= 85 ? 'err' : c >= 70 ? 'warn' : '';
}
