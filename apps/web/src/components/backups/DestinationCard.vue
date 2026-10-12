<script setup lang="ts">
/** A server that keeps copies of this server's folders: reachability and the space set aside there. */
import { computed } from 'vue';
import { HardDrive, Lock, Server, Trash2 } from 'lucide-vue-next';
import type { BackupDestination } from '@apexos/api-types';
import { formatBytes } from '../../lib/format.ts';
import { ago, HEALTH_BADGE, HEALTH_LABEL } from './backups.ts';

const props = defineProps<{ destination: BackupDestination }>();
const emit = defineEmits<{ space: []; remove: [] }>();

const percent = computed(() => {
  const d = props.destination;
  if (d.usedBytes === null || !d.grantedBytes) return null;
  return Math.min(100, Math.round((d.usedBytes / d.grantedBytes) * 100));
});
const meterClass = computed(() => (percent.value === null ? '' : percent.value >= 99 ? 'err' : percent.value >= 90 ? 'warn' : 'ok'));
</script>

<template>
  <article class="card stack dest" style="--gap: 12px" :aria-labelledby="`dest-${destination.id}`">
    <div class="row" style="--gap: 12px; align-items: flex-start">
      <Server :size="22" class="icon" aria-hidden="true" />
      <div class="stack grow" style="--gap: 2px">
        <h3 :id="`dest-${destination.id}`" class="name">{{ destination.name }}</h3>
        <span class="small muted addr">{{ destination.address.replace(/^https?:\/\//, '') }} · pool {{ destination.pool }}</span>
      </div>
      <span class="badge" :class="HEALTH_BADGE[destination.health]">{{ HEALTH_LABEL[destination.health] }}</span>
    </div>

    <div class="stack" style="--gap: 6px">
      <div class="row small" style="--gap: 6px">
        <HardDrive :size="14" class="muted" aria-hidden="true" />
        <span v-if="destination.usedBytes !== null">
          <strong>{{ formatBytes(destination.usedBytes) }}</strong> <span class="muted">of {{ formatBytes(destination.grantedBytes) }} set aside</span>
        </span>
        <span v-else class="muted">{{ formatBytes(destination.grantedBytes) }} set aside</span>
      </div>
      <div
        v-if="percent !== null"
        class="meter"
        :class="meterClass"
        role="meter"
        :aria-valuenow="percent"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-label="`Backup space used on ${destination.name}`"
      >
        <span :style="{ width: `${percent}%` }" />
      </div>
    </div>

    <p v-if="destination.problem" class="small problem" :class="destination.health === 'unreachable' || destination.health === 'full' ? 'err' : 'warn'">{{ destination.problem }}</p>
    <p v-if="destination.encryptedOnly" class="small muted row" style="--gap: 6px"><Lock :size="14" aria-hidden="true" /> Encrypted pool: only encrypted folders can be backed up here.</p>
    <p class="small muted">
      {{ destination.backupCount === 1 ? '1 folder' : `${destination.backupCount} folders` }} backed up here<template v-if="destination.checkedAt"> · checked {{ ago(destination.checkedAt) }}</template>
    </p>

    <div class="row wrap" style="--gap: 6px">
      <button class="btn small" :disabled="destination.health === 'unreachable'" @click="emit('space')">Change space</button>
      <span class="spacer" />
      <button class="btn small ghost danger" @click="emit('remove')"><Trash2 :size="15" /> Remove</button>
    </div>
  </article>
</template>

<style scoped>
.icon {
  color: var(--accent);
  flex-shrink: 0;
  margin-top: 2px;
}
.grow {
  flex: 1;
  min-width: 0;
}
.name {
  font-size: 1.02rem;
  overflow-wrap: anywhere;
}
.addr {
  overflow-wrap: anywhere;
}
.problem {
  border-left: 3px solid var(--warn);
  padding-left: 10px;
}
.problem.err {
  border-color: var(--err);
}
</style>
