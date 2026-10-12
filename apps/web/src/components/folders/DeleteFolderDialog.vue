<script setup lang="ts">
/** Delete confirmation (type the name), or an explanation when apps/locations still use the folder. */
import { ref } from 'vue';
import { Boxes, MapPin } from 'lucide-vue-next';
import type { Folder, TaskStarted } from '@apexos/api-types';
import ConfirmDialog from '../ConfirmDialog.vue';
import Modal from '../Modal.vue';
import { ApiError, api, runTask } from '../../lib/api.ts';
import { formatBytes } from '../../lib/format.ts';
import { useLink } from './folderRules.ts';

const props = defineProps<{ folder: Folder }>();
const emit = defineEmits<{ close: []; deleted: [] }>();

const busy = ref(false);
const error = ref<string | null>(null);
/** Set when the server reports the folder became in use after the dialog opened. */
const inUseMessage = ref<string | null>(null);

async function confirm() {
  busy.value = true;
  error.value = null;
  try {
    await runTask(api.del<TaskStarted>(`/folders/${encodeURIComponent(props.folder.name)}`, { confirmName: props.folder.name }));
    emit('deleted');
  } catch (e) {
    if (e instanceof ApiError && e.code === 'IN_USE') inUseMessage.value = e.message;
    else error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Modal v-if="folder.usedBy.length || inUseMessage" :title="`${folder.name} can’t be deleted yet`" @close="emit('close')">
    <p>
      {{ inUseMessage ?? 'Something still keeps its files here.' }}
      Deleting the folder now would break it, so ApexOs won’t do that.
    </p>
    <ul v-if="folder.usedBy.length" class="uses">
      <li v-for="use in folder.usedBy" :key="`${use.type}-${use.id}`" class="row" style="--gap: 10px">
        <Boxes v-if="use.type === 'app'" :size="16" class="muted" />
        <MapPin v-else :size="16" class="muted" />
        <span>
          <strong>{{ use.name }}</strong>
          <span class="muted small"> · {{ use.type === 'app' ? 'app' : 'location' }}</span>
        </span>
        <span class="spacer" />
        <RouterLink :to="useLink(use)" class="small" @click="emit('close')">{{ use.type === 'app' ? 'Go to Apps' : 'Go to Locations' }}</RouterLink>
      </li>
    </ul>
    <p class="small muted">
      Remove the apps that use it, and point any locations at a different folder in Settings → Locations. Then you can delete it.
    </p>
    <template #footer>
      <button class="btn primary" @click="emit('close')">OK</button>
    </template>
  </Modal>

  <ConfirmDialog
    v-else
    :title="`Delete ${folder.name}?`"
    :message="`This permanently deletes the folder and everything in it (${formatBytes(folder.usedBytes)}), and stops sharing it on your network. It can’t be undone.`"
    action-label="Delete folder"
    danger
    :confirm-text="folder.name"
    :busy="busy"
    :error="error"
    @confirm="confirm"
    @close="emit('close')"
  >
    <p v-if="folder.timeMachine" class="callout warn small">This folder holds Time Machine backups. Those backups will be gone too.</p>
  </ConfirmDialog>
</template>

<style scoped>
.uses {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
</style>
