<script setup lang="ts">
import { computed } from 'vue';
import { formatBytes } from '../lib/format.ts';

const props = withDefaults(defineProps<{ used: number; total: number; size?: number }>(), { size: 76 });
const pct = computed(() => (props.total > 0 ? Math.min(100, (props.used / props.total) * 100) : 0));
const tone = computed(() => (pct.value >= 90 ? 'var(--err)' : pct.value >= 80 ? 'var(--warn)' : 'var(--accent)'));
const r = 15.9155;
</script>

<template>
  <div class="ring" :style="{ width: `${size}px`, height: `${size}px` }" :title="`${formatBytes(used)} used of ${formatBytes(total)} (${formatBytes(total - used)} free)`">
    <svg viewBox="0 0 36 36" role="img" :aria-label="`${Math.round(pct)}% used`">
      <circle cx="18" cy="18" :r="r" fill="none" stroke="var(--surface-2)" stroke-width="3.2" />
      <circle
        cx="18"
        cy="18"
        :r="r"
        fill="none"
        :stroke="tone"
        stroke-width="3.2"
        stroke-linecap="round"
        :stroke-dasharray="`${pct} ${100 - pct}`"
        stroke-dashoffset="25"
      />
    </svg>
    <span class="label">{{ Math.round(pct) }}%</span>
  </div>
</template>

<style scoped>
.ring {
  position: relative;
  flex: none;
}
svg {
  width: 100%;
  height: 100%;
}
.label {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-weight: 650;
  font-size: 0.9rem;
}
</style>
