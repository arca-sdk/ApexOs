<script setup lang="ts">
/**
 * Encryption part of the folder panel: state (locked / unlocked, key mode), Lock / Unlock, switching key
 * mode, "Turn on encryption", and the state of a running or unfinished conversion.
 */
import { computed, ref } from 'vue';
import { KeyRound, Lock, LockKeyhole, RotateCcw, ShieldCheck, ShieldOff, Trash2, Unlock } from 'lucide-vue-next';
import type { Folder, TaskStarted } from '@apexos/api-types';
import ConfirmDialog from '../ConfirmDialog.vue';
import Modal from '../Modal.vue';
import TaskItem from '../notifications/TaskItem.vue';
import { api, runTask } from '../../lib/api.ts';
import { live } from '../../lib/events.ts';
import { formatBytes } from '../../lib/format.ts';
import PasswordInput from '../users/PasswordInput.vue';
import EncryptFolderDialog from './EncryptFolderDialog.vue';
import KeyModeDialog from './KeyModeDialog.vue';
import UnlockDialog from './UnlockDialog.vue';
import { formatDate, MODE_LABELS } from './encryptionRules.ts';

const props = defineProps<{ folder: Folder }>();

const enc = computed(() => props.folder.encryption);
const conv = computed(() => props.folder.conversion ?? null);
const own = computed(() => !!enc.value && enc.value.mode !== 'none' && !enc.value.inherited);
const converting = computed(() => !!conv.value && conv.value.state !== 'done');
const convTask = computed(() => (conv.value?.taskId ? (live.tasks[conv.value.taskId] ?? null) : null));
const lockableApps = computed(() => props.folder.usedBy.filter((u) => u.type === 'app').map((u) => u.name));
const base = computed(() => `/folders/${encodeURIComponent(props.folder.name)}`);

type DialogName = 'lock' | 'unlock' | 'mode' | 'encrypt' | 'retry' | 'discard' | 'safety';
const dialog = ref<DialogName | null>(null);
const busy = ref(false);
const error = ref<string | null>(null);

function open(d: DialogName) {
  error.value = null;
  dialog.value = d;
}

async function run(request: () => Promise<TaskStarted>) {
  busy.value = true;
  error.value = null;
  try {
    await runTask(request());
    dialog.value = null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

const lock = () => run(() => api.post<TaskStarted>(`${base.value}/lock`));
const discard = () => run(() => api.post<TaskStarted>(`${base.value}/encryption/convert/discard`));
const removeCopy = () => run(() => api.del<TaskStarted>(`${base.value}/encryption/safety-copy`));

// Retry: a passphrase run asks for the passphrase again (it was never stored).
const retryPassphrase = ref('');
async function retry() {
  busy.value = true;
  error.value = null;
  try {
    const body = retryPassphrase.value ? { passphrase: retryPassphrase.value } : {};
    retryPassphrase.value = '';
    await api.post<TaskStarted>(`${base.value}/encryption/convert/retry`, body);
    dialog.value = null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
function startRetry() {
  if (conv.value?.mode === 'passphrase' && !conv.value.switched) open('retry');
  else void retry();
}

defineExpose({ openLock: () => open('lock'), openUnlock: () => open('unlock') });
</script>

<template>
  <section class="stack" style="--gap: 10px" aria-labelledby="fp-enc">
    <div class="row wrap" style="--gap: 8px">
      <h3 id="fp-enc">Encryption</h3>
      <span v-if="enc && enc.mode !== 'none' && enc.locked" class="badge warn"><LockKeyhole :size="12" /> Locked</span>
      <span v-else-if="enc && enc.mode !== 'none'" class="badge ok"><ShieldCheck :size="12" /> {{ MODE_LABELS[enc.mode] }}</span>
      <span v-else-if="conv?.state === 'running'" class="badge info">Being encrypted</span>
      <span v-else-if="converting" class="badge err">Unfinished</span>
      <span v-else class="badge"><ShieldOff :size="12" /> Not encrypted</span>
    </div>

    <!-- A conversion that is running or needs attention -->
    <template v-if="conv && conv.state === 'running'">
      <TaskItem v-if="convTask" :task="convTask" show-steps />
      <p v-else class="small muted">Encrypting: {{ conv.step ?? 'starting' }}…</p>
      <p class="small muted">The folder stays usable while the copy is made. Its network share pauses briefly for the switch-over.</p>
    </template>
    <div v-else-if="conv && (conv.state === 'failed' || conv.state === 'interrupted')" class="callout err stack" style="--gap: 8px" role="status">
      <strong>{{ conv.state === 'interrupted' ? 'Encrypting this folder was interrupted' : 'Encrypting this folder didn’t finish' }}</strong>
      <span class="small">{{ conv.error ?? 'ApexOs restarted while it was running.' }}</span>
      <span class="small">
        {{ conv.switched ? 'The encrypted copy already replaced the folder, so retry to finish the last steps.' : 'Your folder hasn’t been changed. Retry to continue, or discard the attempt.' }}
      </span>
      <div class="row wrap" style="--gap: 8px">
        <button class="btn small" :disabled="busy" @click="startRetry"><RotateCcw :size="14" /> Retry</button>
        <button v-if="!conv.switched" class="btn small danger" :disabled="busy" @click="open('discard')">Discard attempt</button>
      </div>
      <p v-if="error && !dialog" class="small">{{ error }}</p>
    </div>

    <template v-if="!converting">
      <!-- Not encrypted -->
      <template v-if="!enc || enc.mode === 'none'">
        <template v-if="!folder.system">
          <p class="small">Files here are stored as they are. Encrypt the folder to keep them unreadable on a drive that is lost, stolen or thrown away.</p>
          <div><button class="btn small" @click="open('encrypt')"><ShieldCheck :size="14" /> Turn on encryption</button></div>
        </template>
        <p v-else class="small muted">ApexOs looks after this folder for apps, so its encryption can’t be changed here.</p>
      </template>

      <!-- Uses the key of a dataset above it -->
      <p v-else-if="enc.inherited" class="small">
        Encrypted together with <span class="mono">{{ enc.root }}</span>. Locking, unlocking and key changes happen there, in TrueNAS.
      </p>

      <!-- Automatic key -->
      <template v-else-if="enc.mode === 'key'">
        <template v-if="enc.locked">
          <p class="callout err small">
            This folder is locked because the server no longer has its key, so its files and network share are unavailable. Unlock it with your recovery file.
          </p>
          <div><button class="btn small primary" @click="open('unlock')"><Unlock :size="14" /> Unlock with recovery file</button></div>
        </template>
        <template v-else>
          <p class="small">
            Encrypted with an automatic key. The server unlocks it by itself when it starts, so it works like any other folder. The files can’t be read
            from the drives on their own.
          </p>
          <p v-if="enc.notInRecoveryFile" class="callout warn small">
            This folder’s key isn’t in your recovery file yet.
            <RouterLink :to="{ path: '/settings', query: { section: 'recovery' } }">Download a new recovery file</RouterLink>
          </p>
          <p v-if="conv?.passphrasePending" class="callout warn small">
            ApexOs restarted before your passphrase was set, so this folder uses an automatic key for now. Set the passphrase again below.
          </p>
          <div><button class="btn small" @click="open('mode')"><KeyRound :size="14" /> Use a passphrase instead</button></div>
        </template>
      </template>

      <!-- Passphrase -->
      <template v-else>
        <template v-if="enc.locked">
          <p class="callout warn small">
            Locked. Its files can’t be opened and its network share is hidden from your network until someone unlocks it with the passphrase.
          </p>
          <p v-if="enc.appsAffected.length" class="small">
            {{ enc.appsAffected.join(', ') }} {{ enc.appsAffected.length === 1 ? 'keeps' : 'keep' }} files here and can’t reach them while the folder is locked.
          </p>
        </template>
        <p v-else class="small">
          Protected by a passphrase. After every restart it stays locked until someone types the passphrase. ApexOs doesn’t keep the passphrase,
          so it isn’t in the recovery file either.
        </p>
        <div class="row wrap" style="--gap: 8px">
          <button v-if="enc.locked" class="btn small primary" @click="open('unlock')"><Unlock :size="14" /> Unlock</button>
          <button v-else class="btn small" @click="open('lock')"><Lock :size="14" /> Lock now</button>
          <button class="btn small" @click="open('mode')"><ShieldCheck :size="14" /> Use an automatic key instead</button>
        </div>
      </template>

      <!-- Safety copy after a finished conversion -->
      <div v-if="conv?.safetyCopy" class="callout stack" style="--gap: 6px">
        <span class="small">
          The unencrypted original ({{ formatBytes(conv.safetyCopy.usedBytes) }}) is kept as a safety copy until {{ formatDate(conv.safetyCopy.removeAfter) }}.
          Until it’s removed, an unencrypted copy of these files is still on the pool.
        </span>
        <div><button class="btn small" @click="open('safety')"><Trash2 :size="14" /> Remove it now</button></div>
      </div>
    </template>
  </section>

  <ConfirmDialog
    v-if="dialog === 'lock'"
    :title="`Lock ${folder.name}?`"
    message="Its files can’t be opened and its network share disappears from your network until someone unlocks it with the passphrase."
    action-label="Lock"
    :busy="busy"
    :error="error"
    @confirm="lock"
    @close="dialog = null"
  >
    <p v-if="lockableApps.length" class="callout warn small">
      {{ lockableApps.join(', ') }} {{ lockableApps.length === 1 ? 'keeps' : 'keep' }} files here and will be stopped. ApexOs starts {{ lockableApps.length === 1 ? 'it' : 'them' }} again when you unlock the folder.
    </p>
  </ConfirmDialog>

  <UnlockDialog v-if="dialog === 'unlock'" :folder="folder" @close="dialog = null" @done="dialog = null" />
  <KeyModeDialog v-if="dialog === 'mode'" :folder="folder" @close="dialog = null" @done="dialog = null" />
  <EncryptFolderDialog v-if="dialog === 'encrypt'" :folder="folder" @close="dialog = null" />

  <Modal v-if="dialog === 'retry'" :title="`Retry encrypting ${folder.name}`" @close="dialog = null">
    <form id="retry-form" class="stack" style="--gap: 12px" @submit.prevent="retry">
      <p>ApexOs doesn’t keep passphrases, so type the passphrase you chose again. Leave it empty to finish with an automatic key and set a passphrase later.</p>
      <div class="field">
        <label for="retry-pass">Passphrase</label>
        <PasswordInput id="retry-pass" v-model="retryPassphrase" autocomplete="new-password" />
      </div>
      <p v-if="error" class="callout err" role="alert">{{ error }}</p>
    </form>
    <template #footer>
      <button class="btn" @click="dialog = null">Cancel</button>
      <button type="submit" form="retry-form" class="btn primary" :disabled="busy"><span v-if="busy" class="spin" />Retry</button>
    </template>
  </Modal>

  <ConfirmDialog
    v-if="dialog === 'discard'"
    :title="`Discard encrypting ${folder.name}?`"
    message="ApexOs removes the partial encrypted copy and its temporary snapshots, and shares the folder again. Your folder itself was never changed."
    action-label="Discard attempt"
    danger
    :busy="busy"
    :error="error"
    @confirm="discard"
    @close="dialog = null"
  />

  <ConfirmDialog
    v-if="dialog === 'safety' && conv?.safetyCopy"
    title="Remove the unencrypted original?"
    :message="`This permanently deletes the unencrypted safety copy of ${folder.name} (${formatBytes(conv.safetyCopy.usedBytes)}). The encrypted folder isn’t touched.`"
    action-label="Remove safety copy"
    danger
    checkbox="I’ve checked that the encrypted folder has everything I need."
    :busy="busy"
    :error="error"
    @confirm="removeCopy"
    @close="dialog = null"
  />
</template>
