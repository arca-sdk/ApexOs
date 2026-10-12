<script setup lang="ts">
import { computed } from 'vue';
import { ExternalLink } from 'lucide-vue-next';
import type { InstalledApp } from '@apexos/api-types';
import { metrics } from '../../lib/events.ts';
import { formatMemory, formatPercent } from '../../lib/format.ts';
import Sparkline from '../Sparkline.vue';
import AppIcon from '../apps/AppIcon.vue';
import AppStateBadge from '../apps/AppStateBadge.vue';
import { appTask } from '../apps/apps.ts';
import { sampleTimes } from './live.ts';

const props = defineProps<{ app: InstalledApp }>();

const cpu = computed(() => metrics.value.map((m) => m.apps[props.app.name]?.cpuPercent ?? 0));
const usage = computed(() => metrics.value.at(-1)?.apps[props.app.name] ?? null);
const running = computed(() => props.app.state === 'running');
const busy = computed(() => appTask(props.app));
const pct = (v: number) => formatPercent(v, 1);
</script>

<template>
  <article class="card app" :aria-labelledby="`dash-app-${app.name}`">
    <div class="top">
      <AppIcon :src="app.icon" :title="app.title" :size="40" />
      <div class="ident">
        <h3 :id="`dash-app-${app.name}`" class="title" :title="app.title">{{ app.title }}</h3>
        <div class="row wrap" style="--gap: 6px">
          <span v-if="busy" class="badge info"><span class="spin tiny" aria-hidden="true" />{{ busy.label }}</span>
          <AppStateBadge v-else :state="app.state" />
          <RouterLink v-if="app.upgradeAvailable" to="/apps" class="badge info" title="An update is available">Update</RouterLink>
        </div>
      </div>
    </div>

    <template v-if="running">
      <div class="stats small">
        <span><span class="muted">CPU</span> <strong>{{ usage ? pct(usage.cpuPercent) : '—' }}</strong></span>
        <span><span class="muted">Memory</span> <strong>{{ usage ? formatMemory(usage.memoryBytes) : '—' }}</strong></span>
      </div>
      <Sparkline :label="`${app.title} processor use over the last 2 minutes`" :values="cpu" :times="sampleTimes" :height="32" :min-max="5" :format="pct" />
    </template>
    <p v-else-if="app.state === 'crashed'" class="small err-text">Stopped unexpectedly. See Apps for details.</p>
    <p v-else class="small muted">Not running</p>

    <div class="actions">
      <a v-if="app.webUrl && running" :href="app.webUrl" target="_blank" rel="noopener" class="btn small primary" :aria-label="`Open ${app.title} (opens in a new tab)`">
        <ExternalLink :size="14" /> Open
      </a>
      <RouterLink v-else to="/apps" class="btn small">Manage</RouterLink>
    </div>
  </article>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  min-width: 0;
}
.top {
  display: flex;
  gap: 12px;
  align-items: center;
  min-width: 0;
}
.ident {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.title {
  font-size: 0.98rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
a.badge:hover {
  text-decoration: none;
  filter: brightness(0.97);
}
.stats {
  display: flex;
  gap: 16px;
  font-variant-numeric: tabular-nums;
}
.err-text {
  color: var(--err);
}
.actions {
  margin-top: auto;
  display: flex;
  gap: 8px;
}
.tiny {
  width: 10px;
  height: 10px;
  border-width: 1.5px;
}
</style>
