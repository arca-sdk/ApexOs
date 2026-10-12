<script setup lang="ts">
/** Live progress (or last result) of a pool check, rebuild or expansion, from `pool.scan`. */
import { computed } from 'vue';
import { CircleAlert, CircleCheck } from 'lucide-vue-next';
import type { PoolScan } from '@hearth/api-types';
import { formatDuration } from '../../lib/format.ts';

const props = defineProps<{ scan: PoolScan | null; compact?: boolean }>();

const running = computed(() => props.scan?.state === 'running' || props.scan?.state === 'paused');
const title = computed(() => {
  const s = props.scan;
  if (!s) return '';
  const what = { scrub: 'Checking the pool', resilver: 'Rebuilding', expand: 'Adding a drive' }[s.kind];
  if (s.state === 'paused') return `${what} (paused)`;
  return what;
});
const explain = computed(() => {
  const s = props.scan;
  if (!s) return '';
  if (s.kind === 'resilver') return 'Copying data onto the new drive. Your files stay available.';
  if (s.kind === 'expand') return 'Spreading data onto the new drive. The pool stays usable, but may be slower.';
  return 'Reading every file to find and repair damage. The pool stays usable.';
});
const left = computed(() => (props.scan?.secondsLeft ? `about ${formatDuration(props.scan.secondsLeft)} left` : null));

const finishedText = computed(() => {
  const s = props.scan;
  if (!s || running.value) return null;
  const when = s.finishedAt ? new Date(s.finishedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : null;
  if (s.state === 'canceled') return { ok: true, text: 'The last check was stopped before it finished.' };
  const what = s.kind === 'resilver' ? 'Last rebuild' : 'Last check';
  if (s.errors > 0) return { ok: false, text: `${what}${when ? ` (${when})` : ''} found ${s.errors} ${s.errors === 1 ? 'problem' : 'problems'}.` };
  return { ok: true, text: `${what}${when ? ` (${when})` : ''} found no problems.` };
});
</script>

<template>
  <div v-if="scan && running" class="scan" role="status" aria-live="polite">
    <div class="row small" style="--gap: 8px">
      <span class="spin" aria-hidden="true" />
      <strong>{{ title }}</strong>
      <span class="spacer" />
      <span>{{ scan.percent }}%</span>
    </div>
    <div class="meter" :class="{ warn: scan.kind === 'resilver' }" role="progressbar" :aria-valuenow="scan.percent" aria-valuemin="0" aria-valuemax="100" :aria-label="title">
      <span :style="{ width: `${scan.percent}%` }" />
    </div>
    <p v-if="!compact" class="small muted">{{ explain }}<template v-if="left"> · {{ left }}</template></p>
  </div>
  <p v-else-if="finishedText" class="row small muted done" style="--gap: 6px">
    <CircleCheck v-if="finishedText.ok" :size="15" style="color: var(--ok)" aria-hidden="true" />
    <CircleAlert v-else :size="15" style="color: var(--err)" aria-hidden="true" />
    {{ finishedText.text }}
  </p>
</template>

<style scoped>
.scan {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
}
.spin {
  width: 14px;
  height: 14px;
  color: var(--accent);
}
.done {
  align-items: flex-start;
}
.done :deep(svg) {
  flex: none;
  margin-top: 3px;
}
</style>
