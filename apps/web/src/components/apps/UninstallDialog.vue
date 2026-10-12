<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { FolderLock } from 'lucide-vue-next';
import type { InstalledApp, LocationInfo } from '@apexos/api-types';
import { api } from '../../lib/api.ts';
import Modal from '../Modal.vue';

const props = defineProps<{ app: InstalledApp }>();
const emit = defineEmits<{ close: []; confirm: [removeData: boolean] }>();

const removeData = ref(false);
const locations = ref<LocationInfo[]>([]);

/** Shared folders (content locations) this app reads or writes. They always stay. */
const sharedFolders = computed(() => locations.value.filter((l) => l.group === 'content' && props.app.locations.includes(l.id) && l.path));

onMounted(async () => {
  if (!props.app.locations.length) return;
  try {
    locations.value = await api.get<LocationInfo[]>('/locations');
  } catch {
    // The list is a nicety; the dialog works without it.
  }
});
</script>

<template>
  <Modal :title="`Uninstall ${app.title}?`" @close="emit('close')">
    <p>{{ app.title }} will be stopped and removed from your server. You can install it again from the catalog later.</p>

    <label class="option">
      <input v-model="removeData" type="checkbox" />
      <span class="stack" style="--gap: 2px">
        <strong>Also delete this app's data</strong>
        <span class="small muted">
          Removes the app's own settings and database, plus the folders it created for itself (even ones inside a shared folder),
          including anything you added through the app.
          Leave this off if you might reinstall {{ app.title }} and want to pick up where you left off.
        </span>
      </span>
    </label>

    <div class="callout ok keep">
      <FolderLock :size="18" aria-hidden="true" class="keep-icon" />
      <div class="stack" style="--gap: 6px">
        <strong>Your shared folders are never deleted</strong>
        <span class="small">Folders like Media, Photos and Documents are never removed, and neither are the files you keep in them yourself, whichever option you choose.</span>
        <ul v-if="sharedFolders.length" class="small kept">
          <li v-for="l in sharedFolders" :key="l.id">
            {{ l.name }} <span class="mono muted">{{ l.path }}</span>
          </li>
        </ul>
      </div>
    </div>

    <p v-if="removeData" class="callout warn small">Deleted app data can't be recovered.</p>

    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn danger solid" @click="emit('confirm', removeData)">
        {{ removeData ? 'Uninstall and delete data' : 'Uninstall' }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.option {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.option input {
  margin-top: 3px;
  flex: none;
}
.keep {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}
.keep-icon {
  flex: none;
  color: var(--ok);
  margin-top: 1px;
}
.kept {
  margin: 0;
  padding-left: 18px;
}
.kept .mono {
  font-size: 0.85em;
  overflow-wrap: anywhere;
}
</style>
