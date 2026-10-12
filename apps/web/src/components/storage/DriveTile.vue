<script setup lang="ts">
/** A pool member in the "View drives" panel: health, badges, identification and Replace. */
import { computed } from 'vue';
import { HardDrive, MemoryStick, Replace, Thermometer } from 'lucide-vue-next';
import type { Drive } from '@apexos/api-types';
import { DRIVE_KIND_LABELS, formatBytes, formatTemperature } from '../../lib/format.ts';
import { driveTitle } from './drives.ts';

const props = defineProps<{
  drive: Drive;
  /** The pool is currently rebuilding onto a drive. */
  rebuilding?: boolean;
  /** Show the Replace button (hidden for single-drive pools and spares). */
  canReplace?: boolean;
  /** Why Replace is disabled right now, if it is. */
  replaceBlocked?: string | null;
}>();
const emit = defineEmits<{ replace: [] }>();

const errorCount = computed(() => props.drive.errors.read + props.drive.errors.write + props.drive.errors.checksum);

const state = computed(() => {
  const d = props.drive;
  const s = (d.status ?? '').toUpperCase();
  if (d.role === 'spare') {
    if (s === 'INUSE') return { cls: 'info', text: 'Covering for a failed drive', detail: 'This spare has taken over for a failed drive.' };
    return { cls: 'ok', text: 'Standing by', detail: 'Ready to take over automatically if a drive fails.' };
  }
  if (d.missing) {
    return { cls: 'err', text: 'Missing', detail: 'The server can’t see this drive. Check that it is connected and powered, or replace it.' };
  }
  if (props.rebuilding && s !== 'ONLINE') return { cls: 'info', text: 'Rebuilding', detail: 'Data is being copied onto this drive.' };
  if (['FAULTED', 'UNAVAIL', 'REMOVED'].includes(s)) {
    return { cls: 'err', text: 'Faulty', detail: 'This drive has stopped working. Replace it to restore protection.' };
  }
  if (s === 'OFFLINE') return { cls: 'warn', text: 'Offline', detail: 'This drive was taken offline.' };
  if (s === 'DEGRADED') return { cls: 'warn', text: 'Failing', detail: 'This drive is having trouble. Plan to replace it.' };
  if (errorCount.value > 0) {
    return {
      cls: 'warn',
      text: 'Check cable',
      detail: 'The drive reported errors. Often a loose or worn cable is to blame; reseat it, then run a pool check.',
    };
  }
  return { cls: 'ok', text: 'Healthy', detail: null };
});

const icon = computed(() => (props.drive.kind === 'HDD' ? HardDrive : MemoryStick));
</script>

<template>
  <div class="tile" :class="state.cls">
    <div class="row top" style="--gap: 10px">
      <component :is="icon" :size="22" class="kind" aria-hidden="true" />
      <div class="grow">
        <strong class="model">{{ driveTitle(drive) }}</strong>
        <div class="small muted">{{ formatBytes(drive.sizeBytes) }} {{ DRIVE_KIND_LABELS[drive.kind] ?? drive.kind }}</div>
      </div>
      <span class="badge" :class="state.cls">{{ state.text }}</span>
    </div>
    <dl class="facts small">
      <div>
        <dt>Serial</dt>
        <dd class="mono">{{ drive.serial }}</dd>
      </div>
      <div v-if="drive.temperatureC !== null">
        <dt><Thermometer :size="13" aria-hidden="true" /> Temperature</dt>
        <dd>{{ formatTemperature(drive.temperatureC) }}</dd>
      </div>
      <div v-if="errorCount > 0">
        <dt>Errors</dt>
        <dd>{{ drive.errors.read }} read · {{ drive.errors.write }} write · {{ drive.errors.checksum }} checksum</dd>
      </div>
    </dl>
    <p v-if="state.detail" class="small detail">{{ state.detail }}</p>
    <div v-if="canReplace" class="row">
      <button class="btn small" :disabled="Boolean(replaceBlocked)" :title="replaceBlocked ?? undefined" @click="emit('replace')">
        <Replace :size="15" aria-hidden="true" /> Replace
      </button>
      <span v-if="replaceBlocked" class="small muted">{{ replaceBlocked }}</span>
    </div>
  </div>
</template>

<style scoped>
.tile {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: var(--surface);
  min-width: 0;
}
.tile.err {
  border-color: var(--err);
}
.tile.warn {
  border-color: var(--warn);
}
.top {
  align-items: flex-start;
}
.kind {
  color: var(--text-muted);
  flex: none;
  margin-top: 2px;
}
.grow {
  flex: 1;
  min-width: 0;
}
.model {
  overflow-wrap: anywhere;
}
.facts {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.facts div {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.facts dt {
  color: var(--text-muted);
  min-width: 90px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.facts dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.detail {
  color: var(--text-muted);
}
.tile.err .detail {
  color: var(--err);
}
</style>
