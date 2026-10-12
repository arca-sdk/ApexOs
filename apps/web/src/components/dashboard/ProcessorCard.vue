<script setup lang="ts">
import { computed } from 'vue';
import { Cpu, Thermometer } from 'lucide-vue-next';
import type { SystemSummary } from '@apexos/api-types';
import { formatPercent, formatTemperature } from '../../lib/format.ts';
import Sparkline from '../Sparkline.vue';
import { latest, sampleTimes, seriesOf, temperatureTone } from './live.ts';

defineProps<{ system: SystemSummary }>();

const usage = seriesOf((m) => m.cpu.usage);
const cores = computed(() => latest.value?.cpu.cores ?? []);
const temp = computed(() => latest.value?.cpu.temperatureC ?? null);
const pct = (v: number) => formatPercent(v, v < 10 ? 1 : 0);
</script>

<template>
  <section class="card metric" aria-labelledby="cpu-title">
    <header class="card-header">
      <Cpu :size="18" class="icon" aria-hidden="true" />
      <h3 id="cpu-title">Processor</h3>
      <span class="spacer" />
      <span v-if="temp !== null" class="badge" :class="temperatureTone(temp)" :title="'Processor temperature'">
        <Thermometer :size="12" aria-hidden="true" />{{ formatTemperature(temp) }}
      </span>
    </header>

    <template v-if="latest">
      <div class="headline">
        <span class="value">{{ pct(latest.cpu.usage) }}</span>
        <span class="muted small">busy</span>
      </div>
      <Sparkline label="Processor usage over the last 2 minutes" :values="usage" :times="sampleTimes" :max="100" :format="pct" />

      <div v-if="cores.length" class="cores-wrap">
        <div class="small muted label">Each core</div>
        <ul class="cores" :aria-label="`${cores.length} processor threads`">
          <li
            v-for="(c, i) in cores"
            :key="i"
            class="core"
            :title="`Core ${i + 1}: ${pct(c.usage)} busy${c.temperatureC !== null ? `, ${formatTemperature(c.temperatureC)}` : ''}`"
          >
            <span class="visually-hidden">Core {{ i + 1 }}:</span>
            <span class="core-usage">{{ Math.round(c.usage) }}<span class="unit">%</span></span>
            <span v-if="c.temperatureC !== null" class="core-temp" :class="temperatureTone(c.temperatureC)">{{ formatTemperature(c.temperatureC) }}</span>
            <span class="core-bar" aria-hidden="true"><span :style="{ width: `${Math.min(100, c.usage)}%` }" /></span>
          </li>
        </ul>
      </div>
    </template>
    <p v-else class="muted small waiting"><span class="spin" aria-hidden="true" /> Waiting for live data…</p>

    <footer class="small muted foot">
      <span class="model" :title="system.cpuModel">{{ system.cpuModel || 'Unknown processor' }}</span>
      <span>
        {{ system.physicalCores }} {{ system.physicalCores === 1 ? 'core' : 'cores' }}<template v-if="system.cores !== system.physicalCores">
          · {{ system.cores }} threads</template
        >
      </span>
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
  gap: 6px;
}
.value {
  font-size: 1.7rem;
  font-weight: 650;
  line-height: 1.1;
}
.label {
  margin-bottom: 6px;
}
.cores {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(46px, 1fr));
  gap: 4px;
}
.core {
  background: var(--surface-2);
  border-radius: 6px;
  padding: 4px 5px 5px;
  display: flex;
  flex-direction: column;
  gap: 1px;
  font-variant-numeric: tabular-nums;
}
.core-usage {
  font-size: 0.82rem;
  font-weight: 600;
}
.unit {
  font-size: 0.7rem;
  color: var(--text-muted);
  font-weight: 500;
}
.core-temp {
  font-size: 0.68rem;
  color: var(--text-muted);
}
.core-temp.warn {
  color: var(--warn);
}
.core-temp.err {
  color: var(--err);
}
.core-bar {
  height: 3px;
  border-radius: 2px;
  background: var(--border);
  overflow: hidden;
  margin-top: 2px;
}
.core-bar span {
  display: block;
  height: 100%;
  background: var(--accent);
  border-radius: 2px;
  transition: width 0.4s;
}
.foot {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.model {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.waiting {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 18px 0;
}
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
</style>
