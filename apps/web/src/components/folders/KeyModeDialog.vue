<script setup lang="ts">
/** Switch a folder between an automatic key and a passphrase. Takes seconds: the data isn't re-encrypted. */
import { computed, reactive } from 'vue';
import type { ChangeKeyModeRequest, Folder, TaskStarted } from '@apexos/api-types';
import Modal from '../Modal.vue';
import PasswordInput from '../users/PasswordInput.vue';
import { api } from '../../lib/api.ts';
import { useTaskRunner } from '../storage/taskRunner.ts';
import PassphraseFields from './PassphraseFields.vue';
import { passphraseProblem } from './encryptionRules.ts';

const props = defineProps<{ folder: Folder }>();
const emit = defineEmits<{ close: []; done: [] }>();

const target = computed<ChangeKeyModeRequest['mode']>(() => (props.folder.encryption?.mode === 'passphrase' ? 'key' : 'passphrase'));
const locked = computed(() => !!props.folder.encryption?.locked);
const form = reactive({ passphrase: '', again: '', current: '', ack: false });
const errors = reactive<{ passphrase?: string; again?: string; current?: string; ack?: string }>({});

const runner = useTaskRunner(() => {
  form.passphrase = form.again = form.current = '';
  emit('done');
});
const serverField = computed(() => runner.fieldErrors.value);

function clear() {
  for (const k of Object.keys(errors) as (keyof typeof errors)[]) delete errors[k];
}

function submit() {
  clear();
  const body: ChangeKeyModeRequest = { mode: target.value };
  if (target.value === 'passphrase') {
    Object.assign(errors, passphraseProblem(form.passphrase, form.again));
    if (!form.ack) errors.ack = 'Tick this to confirm you’ll keep the passphrase safe.';
    body.passphrase = form.passphrase;
  }
  if (locked.value) {
    if (!form.current) errors.current = 'Enter the current passphrase.';
    body.currentPassphrase = form.current;
  }
  if (Object.keys(errors).length) return;
  void runner.start(api.put<TaskStarted>(`/folders/${encodeURIComponent(props.folder.name)}/encryption`, body));
}

const title = computed(() => (target.value === 'passphrase' ? `Use a passphrase for ${props.folder.name}` : `Use an automatic key for ${props.folder.name}`));
</script>

<template>
  <Modal :title="title" @close="emit('close')">
    <form id="key-mode-form" class="stack" style="--gap: 14px" novalidate @submit.prevent="submit">
      <template v-if="target === 'passphrase'">
        <p>
          From now on the folder stays locked after every restart until someone types the passphrase. You can also lock it yourself at any time.
          ApexOs doesn’t keep the passphrase, and it won’t be in your recovery file.
        </p>
        <PassphraseFields id-prefix="km" v-model:passphrase="form.passphrase" v-model:again="form.again" label="New passphrase" :errors="{ passphrase: errors.passphrase ?? serverField.passphrase, again: errors.again }" />
        <label class="row check">
          <input v-model="form.ack" type="checkbox" @change="delete errors.ack" />
          <span class="small">I’ll keep this passphrase somewhere safe. If it’s lost, nobody can open these files again.</span>
        </label>
        <span v-if="errors.ack" class="error-text small">{{ errors.ack }}</span>
      </template>
      <template v-else>
        <p>
          The server keeps the folder’s key and unlocks it by itself when it starts, so it no longer needs a passphrase and can’t be locked by hand.
          Download a new recovery file afterwards so it includes this folder.
        </p>
      </template>
      <div v-if="locked" class="field">
        <label for="km-current">Current passphrase</label>
        <PasswordInput id="km-current" v-model="form.current" autocomplete="new-password" :invalid="!!(errors.current ?? serverField.currentPassphrase)" describedby="km-current-err" />
        <span class="hint">The folder is locked, so it’s unlocked with the current passphrase first.</span>
        <span v-if="errors.current ?? serverField.currentPassphrase" id="km-current-err" class="error-text" role="alert">{{ errors.current ?? serverField.currentPassphrase }}</span>
      </div>
      <p class="small muted">This takes a few seconds and doesn’t change any files. Backups made with the old passphrase still need it to be restored.</p>
      <p v-if="runner.error.value && !Object.keys(serverField).length" class="callout err" role="alert">{{ runner.error.value }}</p>
    </form>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button type="submit" form="key-mode-form" class="btn primary" :disabled="runner.running.value">
        <span v-if="runner.running.value" class="spin" />{{ target === 'passphrase' ? 'Set passphrase' : 'Switch to automatic key' }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.check {
  align-items: flex-start;
  --gap: 10px;
  cursor: pointer;
}
.check input {
  margin-top: 3px;
  flex-shrink: 0;
}
.error-text {
  color: var(--err);
}
</style>
