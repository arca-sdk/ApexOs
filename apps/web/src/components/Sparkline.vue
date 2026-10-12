<script setup lang="ts">
/**
 * Small live line chart (plain SVG). New points enter on the right and the window slides left.
 * Hovering or focusing the chart pauses it and shows a crosshair with the values at that point;
 * arrow keys move the crosshair when the chart has keyboard focus.
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';

export interface SparkSeries {
  label: string;
  values: number[];
  /** CSS colour, e.g. `var(--accent)`. */
  color?: string;
}

const props = withDefaults(
  defineProps<{
    /** Accessible name, e.g. "Processor usage, last 2 minutes". */
    label: string;
    values?: number[];
    series?: SparkSeries[];
    /** Optional sample times (ISO), aligned with the values. */
    times?: string[];
    /** Number of slots in the window; fewer values are drawn against the right edge. */
    capacity?: number;
    /** Fixed top of the scale (e.g. 100 for percentages). Otherwise it follows the data. */
    max?: number;
    /** Smallest automatic top of the scale, so near-zero noise doesn't fill the chart. */
    minMax?: number;
    height?: number;
    format?: (v: number) => string;
  }>(),
  { capacity: 60, height: 56, minMax: 1, format: (v: number) => String(Math.round(v * 10) / 10) },
);

const PALETTE = ['var(--accent)', 'var(--info)'];
const PAD_TOP = 4;
const PAD_BOTTOM = 2;

interface Snapshot {
  series: Required<SparkSeries>[];
  times: string[];
}

const live = computed<Snapshot>(() => ({
  series: (props.series ?? [{ label: props.label, values: props.values ?? [] }]).map((s, i) => ({
    label: s.label,
    values: s.values.slice(-props.capacity),
    color: s.color ?? PALETTE[i % PALETTE.length]!,
  })),
  times: (props.times ?? []).slice(-props.capacity),
}));

/** Data frozen while the reader is hovering/focused, so the crosshair stays on the same sample. */
const frozen = shallowRef<Snapshot | null>(null);
const view = computed(() => frozen.value ?? live.value);
const count = computed(() => Math.max(0, ...view.value.series.map((s) => s.values.length)));

const root = ref<HTMLElement>();
const width = ref(240);
let observer: ResizeObserver | undefined;
onMounted(() => {
  if (!root.value) return;
  width.value = root.value.clientWidth || 240;
  observer = new ResizeObserver((entries) => {
    const w = entries[0]?.contentRect.width;
    if (w) width.value = w;
  });
  observer.observe(root.value);
});
onBeforeUnmount(() => observer?.disconnect());

const top = computed(() => {
  if (props.max !== undefined) return props.max;
  const peak = Math.max(0, ...view.value.series.flatMap((s) => s.values));
  return niceCeil(Math.max(peak * 1.15, props.minMax));
});

function niceCeil(n: number): number {
  const exp = 10 ** Math.floor(Math.log10(n));
  const f = n / exp;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * exp;
}

/** X position of the i-th of `n` values, aligned to the right edge. */
function xAt(i: number, n: number): number {
  const step = width.value / Math.max(1, props.capacity - 1);
  return width.value - (n - 1 - i) * step;
}
function yAt(v: number): number {
  const h = props.height - PAD_TOP - PAD_BOTTOM;
  return PAD_TOP + h - (Math.min(Math.max(v, 0), top.value) / top.value) * h;
}

const paths = computed(() =>
  view.value.series.map((s) => {
    const n = s.values.length;
    if (!n) return { ...s, line: '', area: '' };
    const pts = s.values.map((v, i) => `${xAt(i, n).toFixed(1)},${yAt(v).toFixed(1)}`);
    const line = `M${pts.join('L')}`;
    const base = props.height - PAD_BOTTOM;
    const area = `${line}L${xAt(n - 1, n).toFixed(1)},${base}L${xAt(0, n).toFixed(1)},${base}Z`;
    return { ...s, line, area };
  }),
);

/** Index (into the longest series) under the crosshair, or null when idle. */
const cursor = ref<number | null>(null);

function pause() {
  if (!frozen.value) frozen.value = live.value;
}
function resume() {
  frozen.value = null;
  cursor.value = null;
}

function onPointer(e: PointerEvent) {
  pause();
  const n = count.value;
  if (!n || !root.value) return;
  const x = e.clientX - root.value.getBoundingClientRect().left;
  const step = width.value / Math.max(1, props.capacity - 1);
  const i = Math.round(n - 1 - (width.value - x) / step);
  cursor.value = Math.min(n - 1, Math.max(0, i));
}

function onFocus() {
  pause();
  cursor.value = count.value ? count.value - 1 : null;
}

function onKey(e: KeyboardEvent) {
  const n = count.value;
  if (!n) return;
  const cur = cursor.value ?? n - 1;
  if (e.key === 'ArrowLeft') cursor.value = Math.max(0, cur - 1);
  else if (e.key === 'ArrowRight') cursor.value = Math.min(n - 1, cur + 1);
  else if (e.key === 'Home') cursor.value = 0;
  else if (e.key === 'End') cursor.value = n - 1;
  else return;
  e.preventDefault();
}

const readout = computed(() => {
  const i = cursor.value;
  if (i === null) return null;
  const n = count.value;
  const x = xAt(i, n);
  const rows = view.value.series.map((s) => {
    const offset = n - s.values.length;
    const v = s.values[i - offset];
    return { label: s.label, color: s.color, value: v, y: v === undefined ? null : yAt(v) };
  });
  const t = view.value.times[i - (n - view.value.times.length)];
  const ago = t ? Math.max(0, Math.round((Date.parse(view.value.times.at(-1)!) - Date.parse(t)) / 1000)) : null;
  return { x, rows, when: ago === null ? null : ago === 0 ? 'Latest' : `${ago} s earlier` };
});

const tipStyle = computed(() => {
  const r = readout.value;
  if (!r) return {};
  const left = r.x > width.value / 2;
  return left ? { right: `${width.value - r.x + 8}px` } : { left: `${r.x + 8}px` };
});

const latest = computed(() => {
  const shown = view.value.series.filter((s) => s.values.length);
  if (shown.length === 1 && !props.series) return props.format(shown[0]!.values.at(-1)!);
  return shown.map((s) => `${s.label} ${props.format(s.values.at(-1)!)}`).join(', ');
});
</script>

<template>
  <div
    ref="root"
    class="spark"
    :style="{ height: `${height}px` }"
    tabindex="0"
    role="img"
    :aria-label="latest ? `${label}. Now: ${latest}` : `${label}. Waiting for data`"
    @pointermove="onPointer"
    @pointerleave="resume"
    @focus="onFocus"
    @blur="resume"
    @keydown="onKey"
  >
    <svg :viewBox="`0 0 ${width} ${height}`" :width="width" :height="height" aria-hidden="true">
      <line class="baseline" x1="0" :x2="width" :y1="height - PAD_BOTTOM + 0.5" :y2="height - PAD_BOTTOM + 0.5" />
      <g v-for="p in paths" :key="p.label">
        <path :d="p.area" :fill="p.color" fill-opacity="0.1" stroke="none" />
        <path :d="p.line" :stroke="p.color" fill="none" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
      </g>
      <template v-if="readout">
        <line class="crosshair" :x1="readout.x" :x2="readout.x" y1="0" :y2="height" />
        <template v-for="r in readout.rows" :key="r.label">
          <circle v-if="r.y !== null" :cx="readout.x" :cy="r.y" r="4" :fill="r.color" class="dot" />
        </template>
      </template>
    </svg>
    <div v-if="readout" class="tip" :style="tipStyle">
      <div v-for="r in readout.rows" :key="r.label" class="tip-row">
        <span v-if="readout.rows.length > 1" class="key" :style="{ background: r.color }" />
        <strong>{{ r.value === undefined ? '—' : format(r.value) }}</strong>
        <span v-if="readout.rows.length > 1" class="muted">{{ r.label }}</span>
      </div>
      <div v-if="readout.when" class="muted when">{{ readout.when }}</div>
    </div>
  </div>
</template>

<style scoped>
.spark {
  position: relative;
  width: 100%;
  cursor: crosshair;
  touch-action: pan-y;
  border-radius: 4px;
}
.spark:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
svg {
  display: block;
  overflow: visible;
}
.baseline {
  stroke: var(--border);
  stroke-width: 1;
}
.crosshair {
  stroke: var(--text-muted);
  stroke-width: 1;
}
.dot {
  stroke: var(--surface);
  stroke-width: 2;
}
.tip {
  position: absolute;
  top: -6px;
  z-index: 2;
  pointer-events: none;
  background: var(--surface);
  border: 1px solid var(--border);
  box-shadow: var(--shadow);
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 0.78rem;
  line-height: 1.35;
  white-space: nowrap;
}
.tip-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-variant-numeric: tabular-nums;
}
.key {
  width: 10px;
  height: 2px;
  border-radius: 1px;
}
.when {
  font-size: 0.72rem;
}
</style>
