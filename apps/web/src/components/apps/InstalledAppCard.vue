<script setup lang="ts">
import { computed } from 'vue';
import { ExternalLink, Play, Square, Trash2, X } from 'lucide-vue-next';
import type { AppGpus, InstalledApp } from '@apexos/api-types';
import { metrics } from '../../lib/events.ts';
import { formatMemory, formatPercent } from '../../lib/format.ts';
import AppIcon from './AppIcon.vue';
import AppStateBadge from './AppStateBadge.vue';
import TierBadge from './TierBadge.vue';
import { appTask, displayVersion, updateLabel } from './apps.ts';

const props = defineProps<{ app: InstalledApp; gpus?: AppGpus; error?: string }>();
const emit = defineEmits<{ start: []; stop: []; update: []; uninstall: []; dismissError: []; gpu: [enabled: boolean] }>();

const busy = computed(() => appTask(props.app));
const usage = computed(() => metrics.value.at(-1)?.apps[props.app.name] ?? null);
const running = computed(() => props.app.state === 'running');
const canStop = computed(() => props.app.state === 'running' || props.app.state === 'deploying');
const showName = computed(() => props.app.name.toLowerCase() !== props.app.title.toLowerCase());
/** Shown for apps that can use a graphics card, when there is one (or the app still has it turned on). */
const showGpu = computed(() => Boolean(props.app.gpu && (props.app.gpu.enabled || props.gpus?.usable.length)));
</script>

<template>
  <article class="card app" :aria-labelledby="`app-${app.name}-title`">
    <div class="top">
      <AppIcon :src="app.icon" :title="app.title" :size="48" />
      <div class="ident">
        <h3 :id="`app-${app.name}-title`" class="title" :title="app.title">{{ app.title }}</h3>
        <div class="row wrap meta" style="--gap: 6px">
          <span v-if="showName" class="small muted mono" :title="`App name: ${app.name}`">{{ app.name }}</span>
          <TierBadge :tier="app.tier" />
        </div>
      </div>
      <AppStateBadge :state="app.state" class="state" />
    </div>

    <dl class="facts small">
      <div>
        <dt class="muted">Version</dt>
        <dd>{{ displayVersion(app) }}</dd>
      </div>
      <div v-if="running">
        <dt class="muted">Processor</dt>
        <dd>{{ usage ? formatPercent(usage.cpuPercent, 1) : '—' }}</dd>
      </div>
      <div v-if="running">
        <dt class="muted">Memory</dt>
        <dd>{{ usage ? formatMemory(usage.memoryBytes) : '—' }}</dd>
      </div>
      <div v-if="showGpu">
        <dt class="muted">Graphics card</dt>
        <dd class="row" style="--gap: 6px">
          {{ app.gpu!.enabled ? 'In use' : 'Not used' }}
          <button
            class="btn ghost small link"
            :disabled="Boolean(busy)"
            :aria-label="`${app.gpu!.enabled ? 'Turn off' : 'Turn on'} the graphics card for ${app.title}`"
            @click="emit('gpu', !app.gpu!.enabled)"
          >
            {{ app.gpu!.enabled ? 'Turn off' : 'Turn on' }}
          </button>
        </dd>
      </div>
    </dl>

    <div v-if="app.upgradeAvailable" class="update small">
      <strong>Update available</strong>
      <span class="mono versions">
        {{ updateLabel(app) }}
      </span>
    </div>
    <p v-if="app.state === 'crashed'" class="callout err small">
      This app stopped unexpectedly. Try starting it again. If it keeps happening, its settings may need a look in TrueNAS.
    </p>
    <div v-if="error" class="callout err small error-row" role="alert">
      <span>{{ error }}</span>
      <button class="btn ghost small" aria-label="Dismiss error" @click="emit('dismissError')"><X :size="14" /></button>
    </div>

    <div class="actions">
      <template v-if="busy">
        <span class="row small muted busy" style="--gap: 8px"><span class="spin" aria-hidden="true" />{{ busy.label }}</span>
      </template>
      <template v-else>
        <a
          v-if="app.webUrl && running"
          class="btn primary small"
          :href="app.webUrl"
          target="_blank"
          rel="noopener"
          :aria-label="`Open ${app.title} (opens in a new tab)`"
        >
          <ExternalLink :size="15" /> Open
        </a>
        <button v-else-if="app.webUrl" class="btn small" disabled :title="`Start ${app.title} to open it`">
          <ExternalLink :size="15" /> Open
        </button>
        <button v-if="canStop" class="btn small" :aria-label="`Stop ${app.title}`" @click="emit('stop')"><Square :size="14" /> Stop</button>
        <button v-else class="btn small" :aria-label="`Start ${app.title}`" @click="emit('start')"><Play :size="14" /> Start</button>
        <button v-if="app.upgradeAvailable" class="btn small" :aria-label="`Update ${app.title}`" @click="emit('update')">Update</button>
        <span class="spacer" />
        <button class="btn ghost small danger" :aria-label="`Uninstall ${app.title}`" title="Uninstall" @click="emit('uninstall')">
          <Trash2 :size="15" />
        </button>
      </template>
    </div>
  </article>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px;
  min-width: 0;
}
.top {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.ident {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.meta .mono {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
.state {
  flex: none;
}
.facts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 22px;
  margin: 0;
}
.facts div {
  display: flex;
  flex-direction: column;
}
.facts dd {
  margin: 0;
  font-weight: 550;
  font-variant-numeric: tabular-nums;
}
.facts .link {
  padding: 0 4px;
  font-weight: 500;
  color: var(--accent);
}
.update {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  background: var(--info-soft);
}
.versions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.error-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.error-row span {
  flex: 1;
  overflow-wrap: anywhere;
}
.error-row .btn {
  padding: 0 4px;
}
.actions {
  margin-top: auto;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.busy {
  min-height: 30px;
}
</style>
