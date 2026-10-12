<script setup lang="ts">
/**
 * Unlock a folder: with its passphrase, or (automatic-key folders whose key the server lost) with the key
 * from a recovery file. The file is read in the browser; only this folder's key is sent.
 */
import { computed, ref } from 'vue';
import { FileKey, Unlock } from 'lucide-vue-next';
import type { Folder, TaskStarted, UnlockFolderRequest } from '@apexos/api-types';
import Modal from '../Modal.vue';
import PasswordInput from '../users/PasswordInput.vue';
import { api } from '../../lib/api.ts';
import { useTaskRunner } from '../storage/taskRunner.ts';
import { keyFromRecoveryFile } from './encryptionRules.ts';

const props = defineProps<{ folder: Folder }>();
const emit = defineEmits<{ close: []; done: [] }>();

const byKey = computed(() => props.folder.encryption?.mode === 'key');
const passphrase = ref('');
const key = ref('');
const fileName = ref('');
const localError = ref<string | null>(null);

const runner = useTaskRunner(() => {
  passphrase.value = key.value = '';
  emit('done');
});

async function pickFile(e: Event) {
  localError.value = null;
  const file = (e.target as HTMLInputElement).files?.[0];
  key.value = '';
  fileName.value = file?.name ?? '';
  if (!file) return;
  if (file.size > 1024 * 1024) {
    localError.value = 'That file is too large to be a recovery file.';
    return;
  }
  const found = keyFromRecoveryFile(await file.text(), props.folder.encryption?.root ?? props.folder.dataset);
  if ('problem' in found) localError.value = found.problem;
  else key.value = found.key;
}

const fieldError = computed(() => runner.fieldErrors.value.passphrase ?? runner.fieldErrors.value.key ?? null);
const ready = computed(() => !runner.running.value && (byKey.value ? /^[0-9a-fA-F]{64}$/.test(key.value) : passphrase.value.length > 0));

function submit() {
  if (!ready.value) {
    if (!byKey.value) localError.value = 'Enter the folder’s passphrase.';
    return;
  }
  localError.value = null;
  const body: UnlockFolderRequest = byKey.value ? { key: key.value } : { passphrase: passphrase.value };
  void runner.start(api.post<TaskStarted>(`/folders/${encodeURIComponent(props.folder.name)}/unlock`, body));
}
</script>

<template>
  <Modal :title="`Unlock ${folder.name}`" @close="emit('close')">
    <form id="unlock-form" class="stack" style="--gap: 14px" novalidate @submit.prevent="submit">
      <template v-if="!byKey">
        <p>Type the passphrase you chose for this folder. Its files and network share come back as soon as it’s unlocked.</p>
        <div class="field">
          <label for="unlock-pass">Passphrase</label>
          <PasswordInput id="unlock-pass" v-model="passphrase" autocomplete="new-password" :invalid="!!fieldError" describedby="unlock-err" />
          <span v-if="fieldError" id="unlock-err" class="error-text" role="alert">{{ fieldError }}</span>
        </div>
      </template>
      <template v-else>
        <p>
          The server doesn’t have this folder’s key any more, for example because the drives were moved to a new server. Choose the recovery file
          you downloaded from <em>Settings → Recovery key</em> to unlock it. The server keeps the key again from then on.
        </p>
        <div class="field">
          <label for="unlock-file" class="file-label"><FileKey :size="16" /> Recovery file</label>
          <input id="unlock-file" type="file" accept=".json,application/json" aria-describedby="unlock-file-hint unlock-err" @change="pickFile" />
          <span id="unlock-file-hint" class="hint">Only this folder’s key is read from the file and sent to the server.</span>
          <span v-if="key && !localError" class="small" style="color: var(--ok)">Found the key for {{ folder.name }} in {{ fileName }}.</span>
          <span v-if="fieldError" id="unlock-err" class="error-text" role="alert">{{ fieldError }}</span>
        </div>
      </template>
      <p v-if="localError" class="callout warn small" role="alert">{{ localError }}</p>
      <p v-if="folder.encryption?.appsAffected.length" class="small muted">
        {{ folder.encryption.appsAffected.join(', ') }} {{ folder.encryption.appsAffected.length === 1 ? 'uses' : 'use' }} this folder. Apps that ApexOs stopped
        when it locked the folder are started again.
      </p>
      <p v-if="runner.error.value && !fieldError" class="callout err" role="alert">{{ runner.error.value }}</p>
    </form>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button type="submit" form="unlock-form" class="btn primary" :disabled="runner.running.value">
        <span v-if="runner.running.value" class="spin" /><Unlock v-else :size="16" /> Unlock
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.file-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
input[type='file'] {
  font: inherit;
  color: var(--text);
  max-width: 100%;
}
</style>
