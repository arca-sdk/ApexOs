<script setup lang="ts">
import { computed } from 'vue';
import { ArrowDown, ArrowUp, Network } from 'lucide-vue-next';
import { metrics } from '../../lib/events.ts';
import { formatRate } from '../../lib/format.ts';
import Sparkline from '../Sparkline.vue';
import { formatLinkSpeed, latest, sampleTimes, visibleInterfaces } from './live.ts';

const interfaces = computed(() => visibleInterfaces(latest.value));
const names = computed(() => new Set(interfaces.value.map((n) => n.name)));

/** Totals across the interfaces shown, oldest sample first. */
const series = computed(() => {
  const rx: number[] = [];
  const tx: number[] = [];
  for (const m of metrics.value) {
    let r = 0;
    let t = 0;
    for (const n of m.network) {
      if (!names.value.has(n.name)) continue;
      r += n.rxBytesPerSec;
      t += n.txBytesPerSec;
    }
    rx.push(r);
    tx.push(t);
  }
  return [
    { label: 'Download', values: rx, color: 'var(--info)' },
    { label: 'Upload', values: tx, color: 'var(--accent)' },
  ];
});
</script>

<template>
  <section class="card metric" aria-labelledby="net-title">
    <header class="card-header">
      <Network :size="18" class="icon" aria-hidden="true" />
      <h3 id="net-title">Network</h3>
    </header>

    <template v-if="latest">
      <ul v-if="interfaces.length" class="ifaces">
        <li v-for="n in interfaces" :key="n.name" class="iface">
          <div class="iface-head">
            <span class="dot" :class="{ up: n.up }" aria-hidden="true" />
            <strong class="mono name">{{ n.name }}</strong>
            <span class="small muted">{{ n.up ? formatLinkSpeed(n.speedMbps) : 'Not connected' }}</span>
          </div>
          <div v-if="n.up" class="rates small">
            <span :title="`Receiving on ${n.name}`"><ArrowDown :size="13" class="rx" aria-label="Download" /> {{ formatRate(n.rxBytesPerSec) }}</span>
            <span :title="`Sending on ${n.name}`"><ArrowUp :size="13" class="tx" aria-label="Upload" /> {{ formatRate(n.txBytesPerSec) }}</span>
          </div>
        </li>
      </ul>
      <p v-else class="muted small">No network interfaces reported.</p>

      <div class="chart">
        <div class="legend small muted" aria-hidden="true">
          <span><span class="key rx-key" />Download</span>
          <span><span class="key tx-key" />Upload</span>
        </div>
        <Sparkline label="Network traffic over the last 2 minutes" :series="series" :times="sampleTimes" :min-max="10_000" :format="formatRate" />
      </div>
    </template>
    <p v-else class="muted small waiting"><span class="spin" aria-hidden="true" /> Waiting for live data…</p>
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
.ifaces {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.iface {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.iface-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.name {
  font-size: 0.9rem;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-muted);
}
.dot.up {
  background: var(--ok);
}
.rates {
  display: flex;
  gap: 16px;
  padding-left: 16px;
  font-variant-numeric: tabular-nums;
}
.rates span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.rx {
  color: var(--info);
}
.tx {
  color: var(--accent);
}
.chart {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.legend {
  display: flex;
  gap: 14px;
}
.legend > span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.key {
  width: 12px;
  height: 2px;
  border-radius: 1px;
}
.rx-key {
  background: var(--info);
}
.tx-key {
  background: var(--accent);
}
.waiting {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 18px 0;
}
</style>
