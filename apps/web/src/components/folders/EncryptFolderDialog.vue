<script setup lang="ts">
/**
 * "Turn on encryption" for an existing folder. ZFS can't encrypt a folder in place, so the server makes an
 * encrypted copy next to it, checks it and swaps it in (Copy strategy). This dialog shows what that takes or
 * why it can't start, lets the user pick the key mode, and follows the run.
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { KeyRound, ShieldCheck, TriangleAlert } from 'lucide-vue-next';
import type { ConversionCheck, Folder, StartConversionRequest, Task, TaskStarted } from '@apexos/api-types';
import Modal from '../Modal.vue';
import TaskItem from '../notifications/TaskItem.vue';
import { ApiError, api } from '../../lib/api.ts';
import { live } from '../../lib/events.ts';
import { formatBytes } from '../../lib/format.ts';
import { pollRunningTask } from '../storage/taskPoll.ts';
import PassphraseFields from './PassphraseFields.vue';
import { DURATION_LABELS, passphraseProblem } from './encryptionRules.ts';

const props = defineProps<{ folder: Folder }>();
const emit = defineEmits<{ close: []; started: [] }>();

const check = ref<ConversionCheck | null>(null);
const loadError = ref<string | null>(null);
const loading = ref(true);

async function load() {
  loading.value = true;
  loadError.value = null;
  try {
    check.value = await api.get<ConversionCheck>(`/folders/${encodeURIComponent(props.folder.name)}/encryption/convert`);
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

const form = reactive({ mode: 'key' as StartConversionRequest['mode'], passphrase: '', again: '', ack: false, keepOriginal: true, understood: false });
const errors = reactive<{ passphrase?: string; again?: string; ack?: string; understood?: string }>({});
const submitError = ref<string | null>(null);
const busy = ref(false);

const startedTask = ref<Task | null>(null);
const task = computed(() => (startedTask.value ? (live.tasks[startedTask.value.id] ?? startedTask.value) : null));
pollRunningTask(() => startedTask.value?.id);

async function start() {
  for (const k of Object.keys(errors) as (keyof typeof errors)[]) delete errors[k];
  submitError.value = null;
  if (form.mode === 'passphrase') {
    Object.assign(errors, passphraseProblem(form.passphrase, form.again));
    if (!form.ack) errors.ack = 'Tick this to confirm you’ll keep the passphrase safe.';
  }
  if (!form.understood) errors.understood = 'Tick this to confirm.';
  if (Object.keys(errors).length) return;
  busy.value = true;
  try {
    const body: StartConversionRequest = { mode: form.mode, keepOriginal: form.keepOriginal, ...(form.mode === 'passphrase' ? { passphrase: form.passphrase } : {}) };
    const { task: t } = await api.post<TaskStarted>(`/folders/${encodeURIComponent(props.folder.name)}/encryption/convert`, body);
    form.passphrase = form.again = '';
    startedTask.value = t;
    emit('started');
  } catch (e) {
    submitError.value = e instanceof Error ? e.message : String(e);
    if (e instanceof ApiError && e.code === 'CANNOT_CONVERT') await load();
  } finally {
    busy.value = false;
  }
}

const used = computed(() => formatBytes(props.folder.usedBytes));
</script>

<template>
  <Modal :title="`Encrypt ${folder.name}`" wide @close="emit('close')">
    <div v-if="task" class="stack" style="--gap: 14px">
      <TaskItem :task="task" show-steps />
      <p v-if="task.status === 'running'" class="small muted">
        You can close this window: the server carries on, and the folder page shows how far it got. The folder stays usable while the copy is made;
        its network share pauses for the last steps.
      </p>
      <p v-else-if="task.status === 'success'" class="callout ok">
        {{ folder.name }} is now encrypted.
        <template v-if="form.keepOriginal"> The unencrypted original is kept for a few days as a safety copy; you can remove it from the folder page.</template>
      </p>
      <p v-else class="callout err">It didn’t finish. You can retry or discard the attempt from the folder page.</p>
    </div>

    <div v-else-if="loading" class="row muted"><span class="spin" /> Checking the folder…</div>
    <div v-else-if="loadError" class="callout err stack" style="--gap: 8px">
      <span>Couldn’t check the folder: {{ loadError }}</span>
      <div><button class="btn small" @click="load">Try again</button></div>
    </div>

    <div v-else-if="check && !check.allowed" class="stack" style="--gap: 12px">
      <p>Encryption can’t be turned on for {{ folder.name }} right now:</p>
      <ul class="blockers">
        <li v-for="b in check.blockers" :key="b.code + b.message" class="row" style="--gap: 10px">
          <TriangleAlert :size="16" class="warn-icon" />
          <span>{{ b.message }}</span>
        </li>
      </ul>
    </div>

    <form v-else-if="check" id="encrypt-form" class="stack" style="--gap: 16px" novalidate @submit.prevent="start">
      <p>
        A folder can’t be encrypted where it is, so ApexOs makes an encrypted copy of {{ folder.name }} ({{ used }}) next to it, checks that every
        file arrived, and then swaps the copy in. The share’s address, who can open it, its storage limit and its restore points stay the same.
      </p>
      <dl class="facts small">
        <dt>Free space needed</dt>
        <dd>{{ formatBytes(check.spaceNeededBytes) }} <span class="muted">({{ formatBytes(check.freeBytes) }} free)</span></dd>
        <dt>Expected time</dt>
        <dd>{{ DURATION_LABELS[check.duration] }}</dd>
        <dt>Interruption</dt>
        <dd>The network share pauses for a moment at the switch-over</dd>
        <template v-if="check.childDatasets.length">
          <dt>Included</dt>
          <dd>{{ check.childDatasets.join(', ') }}</dd>
        </template>
        <template v-if="check.snapshots">
          <dt>Restore points</dt>
          <dd>{{ check.snapshots }} copied along</dd>
        </template>
      </dl>

      <fieldset class="plain stack" style="--gap: 8px">
        <legend class="field-label">How should it be unlocked?</legend>
        <label class="choice" :class="{ selected: form.mode === 'key' }">
          <input v-model="form.mode" type="radio" name="enc-mode" value="key" />
          <ShieldCheck :size="18" class="choice-icon" />
          <span class="stack" style="--gap: 2px">
            <strong>Automatic key <span class="badge ok">Recommended</span></strong>
            <span class="small muted">Unlocks by itself when the server starts. Download a new recovery file afterwards.</span>
          </span>
        </label>
        <label class="choice" :class="{ selected: form.mode === 'passphrase' }">
          <input v-model="form.mode" type="radio" name="enc-mode" value="passphrase" />
          <KeyRound :size="18" class="choice-icon" />
          <span class="stack" style="--gap: 2px">
            <strong>Passphrase</strong>
            <span class="small muted">Stays locked after every restart until you type it. ApexOs never stores it.</span>
          </span>
        </label>
      </fieldset>
      <div v-if="form.mode === 'passphrase'" class="card flat stack inset" style="--gap: 12px">
        <PassphraseFields id-prefix="enc" v-model:passphrase="form.passphrase" v-model:again="form.again" :errors="errors" />
        <label class="row check">
          <input v-model="form.ack" type="checkbox" @change="delete errors.ack" />
          <span class="small">I’ll keep this passphrase somewhere safe. If it’s lost, nobody can open these files again.</span>
        </label>
        <span v-if="errors.ack" class="error-text small">{{ errors.ack }}</span>
      </div>

      <label class="row check">
        <input v-model="form.keepOriginal" type="checkbox" />
        <span class="stack" style="--gap: 2px">
          <strong>Keep the unencrypted original for a few days</strong>
          <span class="small muted">A safety copy, hidden from your folders and removed automatically after 7 days, or earlier from the folder page. Until then an unencrypted copy of these files is still on the pool.</span>
        </span>
      </label>

      <label class="row check">
        <input v-model="form.understood" type="checkbox" :aria-invalid="!!errors.understood || undefined" @change="delete errors.understood" />
        <span class="small">
          I understand this can’t be undone: once encrypted, {{ folder.name }} stays encrypted (switching between an automatic key and a passphrase
          stays possible). Old unencrypted traces can remain on the drives until they’re overwritten.
        </span>
      </label>
      <span v-if="errors.understood" class="error-text small">{{ errors.understood }}</span>
      <p v-if="submitError" class="callout err" role="alert">{{ submitError }}</p>
    </form>

    <template #footer>
      <template v-if="task">
        <button class="btn primary" @click="emit('close')">{{ task.status === 'running' ? 'Close' : 'Done' }}</button>
      </template>
      <template v-else>
        <button class="btn" @click="emit('close')">{{ check && !check.allowed ? 'OK' : 'Cancel' }}</button>
        <button v-if="check?.allowed" type="submit" form="encrypt-form" class="btn primary" :disabled="busy">
          <span v-if="busy" class="spin" />Turn on encryption
        </button>
      </template>
    </template>
  </Modal>
</template>

<style scoped>
.blockers {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.blockers li {
  align-items: flex-start;
}
.warn-icon {
  color: var(--warn);
  flex-shrink: 0;
  margin-top: 3px;
}
.facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 14px;
  margin: 0;
}
.facts dt {
  color: var(--text-muted);
}
.facts dd {
  margin: 0;
}
.plain {
  border: 0;
  margin: 0;
  padding: 0;
  min-width: 0;
}
.plain legend {
  padding: 0;
  margin-bottom: 6px;
}
.choice {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.choice input {
  margin-top: 3px;
  flex-shrink: 0;
}
.choice.selected {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.choice-icon {
  margin-top: 2px;
  flex-shrink: 0;
  color: var(--text-muted);
}
.choice strong .badge {
  margin-left: 6px;
}
.inset {
  padding: 16px;
  background: var(--surface-2);
}
.check {
  align-items: flex-start;
  --gap: 10px;
  cursor: pointer;
}
.check input {
  margin-top: 3px;
  flex-shrink: 0;
}
@media (max-width: 480px) {
  .facts {
    grid-template-columns: 1fr;
  }
  .facts dd {
    margin-bottom: 6px;
  }
}
.error-text {
  color: var(--err);
}
</style>
