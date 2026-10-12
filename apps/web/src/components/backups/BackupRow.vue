<script setup lang="ts">
/** One folder backed up to one destination: status, schedule and actions. */
import { computed } from 'vue';
import { ArchiveRestore, CircleCheck, CirclePause, CircleX, Clock, Lock, Pause, Play, RefreshCw, Settings2, Trash2, TriangleAlert, Upload } from 'lucide-vue-next';
import type { Backup, BackupDestination } from '@apexos/api-types';
import { formatBytes } from '../../lib/format.ts';
import { ago, keepText, scheduleText, serverTime, speedText, STATE_BADGE } from './backups.ts';

const props = defineProps<{ backup: Backup; destination: BackupDestination | undefined; timezone: string; busy?: boolean }>();
const emit = defineEmits<{ run: []; restore: []; settings: []; pause: []; resume: []; freshCopy: []; remove: [] }>();

const s = computed(() => props.backup.status);
const offline = computed(() => props.destination?.health === 'unreachable');
const running = computed(() => s.value.state === 'running' || props.busy);
const canRun = computed(() => !running.value && !offline.value && !props.backup.paused && props.backup.folderExists && s.value.state !== 'needs-fresh-copy');
const icon = computed(() => {
  switch (s.value.state) {
    case 'ok':
      return CircleCheck;
    case 'failed':
      return CircleX;
    case 'paused':
      return CirclePause;
    case 'overdue':
    case 'needs-fresh-copy':
      return TriangleAlert;
    default:
      return Clock;
  }
});
</script>

<template>
  <article class="backup" :aria-labelledby="`bk-${backup.id}`">
    <div class="row head" style="--gap: 12px">
      <span v-if="running" class="spin state-icon running" aria-hidden="true" />
      <component :is="icon" v-else :size="20" class="state-icon" :class="s.state" aria-hidden="true" />
      <div class="stack grow" style="--gap: 2px">
        <h3 :id="`bk-${backup.id}`" class="title">
          <RouterLink v-if="backup.folderExists" :to="{ path: '/folders', query: { folder: backup.folder } }">{{ backup.folder }}</RouterLink>
          <span v-else>{{ backup.folder }}</span>
          <span class="muted to"> to {{ backup.destinationName }}</span>
        </h3>
        <div class="row wrap small" style="--gap: 8px">
          <span class="badge" :class="STATE_BADGE[s.state]">{{ running ? 'Backing up' : s.label }}</span>
          <span v-if="backup.encrypted" class="badge"><Lock :size="12" aria-hidden="true" /> Encrypted</span>
          <span class="muted">Last backup: {{ ago(s.lastSuccessAt) }}</span>
          <span v-if="s.nextRunAt && !running" class="muted">· Next: {{ serverTime(s.nextRunAt, timezone) }}</span>
        </div>
      </div>
    </div>

    <div v-if="running" class="progress stack" style="--gap: 4px" role="status" aria-live="polite">
      <div class="meter" role="progressbar" :aria-valuenow="s.progress?.percent ?? 0" aria-valuemin="0" aria-valuemax="100" aria-label="Backup progress">
        <span :style="{ width: `${s.progress?.percent ?? 0}%` }" />
      </div>
      <span class="small muted">
        {{ s.progress?.percent ?? 0 }}%<template v-if="s.progress?.bytesTotal"> · {{ formatBytes(s.progress.bytesSent) }} of {{ formatBytes(s.progress.bytesTotal) }}</template>
      </span>
    </div>
    <p v-if="s.detail" class="small detail" :class="s.state === 'failed' ? 'err' : s.state === 'paused' ? 'muted' : 'warn'">{{ s.detail }}</p>

    <p class="small muted meta">
      {{ scheduleText(backup.schedule) }} · keeps {{ keepText(backup.keepDays) }} · {{ speedText(backup.speedLimitMbps) }}
      <template v-if="backup.restorePoints !== null"> · {{ backup.restorePoints }} restore {{ backup.restorePoints === 1 ? 'point' : 'points' }}</template>
      <template v-if="backup.remoteUsedBytes !== null"> · {{ formatBytes(backup.remoteUsedBytes) }} on {{ backup.destinationName }}</template>
    </p>

    <div class="row wrap actions" style="--gap: 6px">
      <button v-if="s.state === 'needs-fresh-copy'" class="btn small primary" :disabled="running || offline" @click="emit('freshCopy')"><RefreshCw :size="15" /> Start a fresh copy</button>
      <button v-else class="btn small" :disabled="!canRun" :title="offline ? `${backup.destinationName} can’t be reached` : undefined" @click="emit('run')">
        <Upload :size="15" /> Back up now
      </button>
      <button class="btn small" :disabled="offline || backup.restorePoints === 0" @click="emit('restore')"><ArchiveRestore :size="15" /> Restore</button>
      <button class="btn small" @click="emit('settings')"><Settings2 :size="15" /> Schedule</button>
      <button v-if="backup.paused" class="btn small" @click="emit('resume')"><Play :size="15" /> Resume</button>
      <button v-else class="btn small" :disabled="running" @click="emit('pause')"><Pause :size="15" /> Pause</button>
      <button class="btn small ghost danger" @click="emit('remove')"><Trash2 :size="15" /> Remove</button>
    </div>
  </article>
</template>

<style scoped>
.backup {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 18px;
}
.head {
  align-items: flex-start;
}
.grow {
  flex: 1;
  min-width: 0;
}
.title {
  font-size: 1rem;
  overflow-wrap: anywhere;
}
.to {
  font-weight: 500;
}
.state-icon {
  flex-shrink: 0;
  margin-top: 2px;
  color: var(--text-muted);
}
.state-icon.ok {
  color: var(--ok);
}
.state-icon.failed {
  color: var(--err);
}
.state-icon.overdue,
.state-icon.needs-fresh-copy {
  color: var(--warn);
}
.state-icon.running {
  width: 18px;
  height: 18px;
  color: var(--accent);
}
.detail {
  border-left: 3px solid var(--warn);
  padding-left: 10px;
  overflow-wrap: anywhere;
}
.detail.err {
  border-color: var(--err);
}
.detail.muted {
  border-color: var(--border);
}
.meta {
  overflow-wrap: anywhere;
}
.actions .btn {
  white-space: nowrap;
}
</style>
