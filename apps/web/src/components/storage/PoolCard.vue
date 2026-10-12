<script setup lang="ts">
/** One pool on the Storage page: capacity ring, protection, live progress, health and actions. */
import { computed } from 'vue';
import { HardDrive, Layers, LifeBuoy, Pencil, Plus, ScanSearch, Shield, ShieldAlert, ShieldCheck, Trash2, TrendingUp } from 'lucide-vue-next';
import type { Pool, Task } from '@hearth/api-types';
import CapacityRing from '../CapacityRing.vue';
import HealthBadge from '../HealthBadge.vue';
import MoreMenu, { type MenuItem } from './MoreMenu.vue';
import ScanProgress from './ScanProgress.vue';
import TaskProgress from './TaskProgress.vue';
import { formatBytes, toleranceText } from '../../lib/format.ts';

const props = defineProps<{ pool: Pool; tasks?: Task[]; scrubBusy?: boolean; scrubError?: string | null }>();
const emit = defineEmits<{ drives: []; scrub: []; rename: []; addDrive: []; addSpare: []; delete: [] }>();

const tolerance = computed(() => props.pool.layout.faultTolerance);
const ProtectionIcon = computed(() => (tolerance.value === null ? Shield : tolerance.value > 0 ? ShieldCheck : ShieldAlert));
const kindText = computed(() => ({ capacity: 'hard drives', performance: 'SSDs', mixed: 'mixed drives' })[props.pool.kind]);
const driveText = computed(() => {
  const n = props.pool.drives.length;
  const spares = props.pool.spares.length;
  return `${n} ${n === 1 ? 'drive' : 'drives'} (${kindText.value})${spares ? ` + ${spares} ${spares === 1 ? 'spare' : 'spares'}` : ''}`;
});
const growText = computed(() =>
  props.pool.layout.expandable ? 'Can grow one drive at a time' : 'Grows only by swapping in bigger drives',
);
const detailClass = computed(() => ({ degraded: 'warn', offline: 'err', errors: 'err', rebuilding: '', healthy: '', unknown: 'warn' })[props.pool.health]);
const scanRunning = computed(() => props.pool.scan?.state === 'running');

const menu = computed<MenuItem[]>(() => [
  { key: 'rename', label: 'Rename', icon: Pencil },
  {
    key: 'addDrive',
    label: 'Add a drive',
    icon: Plus,
    disabled: !props.pool.layout.expandable,
    hint: props.pool.layout.expandable ? undefined : 'Only single-group RAIDZ pools can grow one drive at a time.',
  },
  {
    key: 'addSpare',
    label: 'Add a hot spare',
    icon: LifeBuoy,
    disabled: !tolerance.value,
    hint: tolerance.value ? undefined : 'Spares only help pools that have protection.',
  },
  { key: 'delete', label: 'Delete pool…', icon: Trash2, danger: true },
]);

function onMenu(key: string) {
  if (key === 'rename') emit('rename');
  else if (key === 'addDrive') emit('addDrive');
  else if (key === 'addSpare') emit('addSpare');
  else if (key === 'delete') emit('delete');
}
</script>

<template>
  <article class="card pool stack" style="--gap: 14px" :aria-labelledby="`pool-${pool.id}-title`">
    <header class="row head" style="--gap: 10px">
      <div class="title">
        <h2 :id="`pool-${pool.id}-title`">{{ pool.displayName }}</h2>
        <p v-if="pool.displayName !== pool.name" class="small muted">Stored as <span class="mono">{{ pool.name }}</span></p>
      </div>
      <span class="spacer" />
      <MoreMenu :items="menu" :label="`More actions for ${pool.displayName}`" @select="onMenu" />
    </header>
    <div class="row wrap" style="--gap: 6px">
      <HealthBadge :health="pool.health" />
      <span v-if="pool.isAppsPool" class="badge accent">Apps run here</span>
    </div>

    <div class="row capacity" style="--gap: 16px">
      <CapacityRing :used="pool.usedBytes" :total="pool.sizeBytes" />
      <div class="stack" style="--gap: 2px">
        <div>
          <strong>{{ formatBytes(pool.usedBytes) }}</strong> <span class="muted">used of {{ formatBytes(pool.sizeBytes) }}</span>
        </div>
        <div class="small muted">{{ formatBytes(pool.freeBytes) }} free</div>
      </div>
    </div>

    <ul class="facts small">
      <li><Layers :size="15" aria-hidden="true" /> {{ pool.layout.label }}</li>
      <li :class="{ weak: tolerance === 0 }"><component :is="ProtectionIcon" :size="15" aria-hidden="true" /> {{ toleranceText(tolerance) }}</li>
      <li><HardDrive :size="15" aria-hidden="true" /> {{ driveText }}</li>
      <li><TrendingUp :size="15" aria-hidden="true" /> {{ growText }}</li>
    </ul>

    <p v-if="pool.healthDetail" class="callout" :class="detailClass">{{ pool.healthDetail }}</p>
    <p v-if="!pool.scrubScheduled" class="callout warn small">
      This pool has no regular health check scheduled. Run <strong>Check pool</strong> now and then to catch damage early.
    </p>

    <ScanProgress :scan="pool.scan" />
    <TaskProgress v-for="t in tasks ?? []" :key="t.id" :task="t" />
    <p v-if="scrubError" class="callout err small">{{ scrubError }}</p>

    <div class="spacer" />
    <footer class="row wrap" style="--gap: 8px">
      <button class="btn small" @click="emit('drives')"><HardDrive :size="15" aria-hidden="true" /> View drives</button>
      <button
        class="btn small"
        :disabled="scanRunning || scrubBusy || pool.health === 'offline'"
        :title="scanRunning ? 'Wait for the current check or rebuild to finish.' : undefined"
        @click="emit('scrub')"
      >
        <span v-if="scrubBusy" class="spin" aria-hidden="true" /><ScanSearch v-else :size="15" aria-hidden="true" /> Check pool
      </button>
    </footer>
  </article>
</template>

<style scoped>
.pool {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.head {
  align-items: flex-start;
}
.title {
  min-width: 0;
}
.title h2 {
  overflow-wrap: anywhere;
}
.capacity {
  padding: 4px 0;
}
.facts {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.facts li {
  display: flex;
  align-items: center;
  gap: 8px;
}
.facts li :deep(svg) {
  color: var(--text-muted);
  flex: none;
}
.facts li.weak,
.facts li.weak :deep(svg) {
  color: var(--warn);
}
.spin {
  width: 14px;
  height: 14px;
}
</style>
