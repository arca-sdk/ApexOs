<script setup lang="ts">
import { computed } from 'vue';
import { MemoryStick } from 'lucide-vue-next';
import type { SystemSummary } from '@hearth/api-types';
import { formatMemory } from '../../lib/format.ts';
import Sparkline from '../Sparkline.vue';
import { latest, memoryBreakdown, sampleTimes, seriesOf } from './live.ts';

const props = defineProps<{ system: SystemSummary }>();

const parts = computed(() => (latest.value ? memoryBreakdown(latest.value.memory) : null));
const total = computed(() => parts.value?.total ?? props.system.memoryBytes);
const used = seriesOf((m) => memoryBreakdown(m.memory).services);
const pct = (n: number) => (total.value ? (n / total.value) * 100 : 0);
</script>

<template>
  <section class="card metric" aria-labelledby="mem-title">
    <header class="card-header">
      <MemoryStick :size="18" class="icon" aria-hidden="true" />
      <h3 id="mem-title">Memory</h3>
      <span class="spacer" />
      <span v-if="system.eccMemory" class="badge ok" title="Error-correcting memory guards against silent data corruption">ECC</span>
    </header>

    <template v-if="parts">
      <div class="headline">
        <span class="value">{{ formatMemory(parts.services) }}</span>
        <span class="muted small">in use of {{ formatMemory(total) }}</span>
      </div>

      <div class="stackbar" role="img" :aria-label="`Apps and system ${formatMemory(parts.services)}, cache ${formatMemory(parts.cache)}, free ${formatMemory(parts.free)}`">
        <span class="seg services" :style="{ width: `${pct(parts.services)}%` }" />
        <span class="seg cache" :style="{ width: `${pct(parts.cache)}%` }" />
      </div>
      <ul class="legend small">
        <li><span class="sw services" aria-hidden="true" />Apps &amp; system <strong>{{ formatMemory(parts.services) }}</strong></li>
        <li :title="'ZFS keeps recently used files in memory to speed things up, and gives it back when apps need it.'">
          <span class="sw cache" aria-hidden="true" />Cache <strong>{{ formatMemory(parts.cache) }}</strong>
        </li>
        <li><span class="sw free" aria-hidden="true" />Free <strong>{{ formatMemory(parts.free) }}</strong></li>
      </ul>

      <Sparkline label="Memory used by apps and system over the last 2 minutes" :values="used" :times="sampleTimes" :max="total" :format="(v) => formatMemory(v)" />
    </template>
    <p v-else class="muted small waiting"><span class="spin" aria-hidden="true" /> Waiting for live data…</p>

    <footer class="small muted foot">
      Cache is memory that speeds up your files. It shrinks automatically when apps need room.
    </footer>
  </section>
</template>

<style scoped>
.metric {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.card-header {
  margin-bottom: 0;
  gap: 8px;
}
.icon {
  color: var(--accent);
}
.headline {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 6px;
}
.value {
  font-size: 1.7rem;
  font-weight: 650;
  line-height: 1.1;
}
.stackbar {
  display: flex;
  gap: 2px;
  height: 10px;
  border-radius: 999px;
  background: var(--surface-2);
  overflow: hidden;
}
.seg {
  display: block;
  height: 100%;
  transition: width 0.4s;
}
.seg:first-child {
  border-radius: 999px 0 0 999px;
}
.services,
.sw.services {
  background: var(--accent);
}
.cache,
.sw.cache {
  background: var(--info);
}
.sw.free {
  background: var(--surface-2);
  border: 1px solid var(--border);
}
.legend {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  color: var(--text-muted);
}
.legend li {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.legend strong {
  color: var(--text);
  font-weight: 600;
}
.sw {
  width: 10px;
  height: 10px;
  border-radius: 3px;
}
.foot {
  margin-top: auto;
}
.waiting {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 18px 0;
}
</style>
