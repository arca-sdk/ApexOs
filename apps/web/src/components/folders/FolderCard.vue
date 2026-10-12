<script setup lang="ts">
import { computed } from 'vue';
import { Folder as FolderIcon, FolderCog, Globe, History, Lock } from 'lucide-vue-next';
import type { Folder } from '@apexos/api-types';
import { formatBytes } from '../../lib/format.ts';

const props = defineProps<{ folder: Folder }>();

const quotaPercent = computed(() =>
  props.folder.quotaBytes ? Math.min(100, Math.round((props.folder.usedBytes / props.folder.quotaBytes) * 100)) : null,
);
const meterClass = computed(() => (quotaPercent.value === null ? '' : quotaPercent.value >= 95 ? 'err' : quotaPercent.value >= 80 ? 'warn' : ''));

const who = computed(() => {
  const f = props.folder;
  if (!f.shared) return 'Not shared on the network';
  if (f.access === 'public') return 'Everyone on your network';
  if (!f.users.length) return 'Only the admin account';
  return f.users.length === 1 ? `${f.users[0]!.username} and the admin` : `${f.users.length} people and the admin`;
});
</script>

<template>
  <RouterLink :to="{ path: '/folders', query: { folder: folder.name } }" class="card folder-card" :aria-label="`${folder.name}, open details`">
    <div class="row top" style="--gap: 10px">
      <span class="icon" :class="{ system: folder.system }">
        <FolderCog v-if="folder.system" :size="20" />
        <FolderIcon v-else :size="20" />
      </span>
      <div class="stack name-block" style="--gap: 0">
        <strong class="name">{{ folder.name }}</strong>
        <span class="small muted">on {{ folder.poolDisplayName }}</span>
      </div>
    </div>

    <div class="row wrap badges" style="--gap: 6px">
      <template v-if="folder.shared">
        <span v-if="folder.access === 'public'" class="badge info"><Globe :size="12" /> Public</span>
        <span v-else class="badge"><Lock :size="12" /> Private</span>
      </template>
      <span v-else class="badge">Not shared</span>
      <span v-if="folder.timeMachine" class="badge accent"><History :size="12" /> Time Machine</span>
    </div>

    <div class="stack" style="--gap: 6px">
      <div class="row small" style="--gap: 6px">
        <span>{{ formatBytes(folder.usedBytes) }} used</span>
        <template v-if="folder.quotaBytes">
          <span class="muted">of {{ formatBytes(folder.quotaBytes) }}</span>
        </template>
      </div>
      <div v-if="quotaPercent !== null" class="meter" :class="meterClass" role="presentation"><span :style="{ width: `${quotaPercent}%` }" /></div>
    </div>

    <p class="small muted who">{{ who }}</p>
    <p v-if="folder.system && folder.usedBy.length" class="small muted">Used by {{ folder.usedBy.map((u) => u.name).join(', ') }}</p>
  </RouterLink>
</template>

<style scoped>
.folder-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  color: var(--text);
  padding: 16px 18px;
  transition:
    border-color 0.12s,
    transform 0.12s;
}
.folder-card:hover {
  text-decoration: none;
  border-color: var(--accent);
}
.folder-card:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.icon {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: var(--accent-soft);
  color: var(--accent-strong);
  flex-shrink: 0;
}
.icon.system {
  background: var(--surface-2);
  color: var(--text-muted);
}
.name-block {
  min-width: 0;
}
.name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.who {
  margin-top: auto;
}
</style>
