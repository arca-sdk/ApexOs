<script setup lang="ts">
/**
 * "Erase everything and start over": lists what goes, asks for the server's name, the password (and a code
 * when two-factor sign-in is on), follows the run and then sends the user to setup.
 */
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { Eraser, TriangleAlert } from 'lucide-vue-next';
import type { ResetPreview, ResetRequest, TaskStarted } from '@apexos/api-types';
import Modal from '../Modal.vue';
import CodeInput from '../account/CodeInput.vue';
import TaskItem from '../notifications/TaskItem.vue';
import { useTaskRunner } from '../storage/taskRunner.ts';
import { api, refreshStatus } from '../../lib/api.ts';
import { formatBytes } from '../../lib/format.ts';

const router = useRouter();
const open = ref(false);
const preview = ref<ResetPreview | null>(null);
const loadError = ref<string | null>(null);
const confirm = ref('');
const password = ref('');
const code = ref('');
const recovery = ref(false);
const runner = useTaskRunner(async () => {
  await refreshStatus();
  await router.replace('/setup');
});

async function start() {
  open.value = true;
  preview.value = null;
  loadError.value = null;
  confirm.value = password.value = code.value = '';
  recovery.value = false;
  runner.error.value = null;
  try {
    preview.value = await api.get<ResetPreview>('/system/reset');
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e);
  }
}

const list = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? ''));
const canErase = computed(() => {
  const p = preview.value;
  return Boolean(p && !p.blockers.length && confirm.value.trim() === p.confirmText && password.value && (!p.needsCode || code.value.trim()) && !runner.running.value);
});

function erase() {
  if (!canErase.value || !preview.value) return;
  const body: ResetRequest = { password: password.value, confirm: confirm.value, ...(preview.value.needsCode ? { code: code.value } : {}) };
  void runner.start(api.post<TaskStarted>('/system/reset', body));
}
</script>

<template>
  <section class="card stack" aria-labelledby="rs-h">
    <h2 id="rs-h">Start over</h2>
    <p class="muted small">
      Erase everything on this server and set it up again from the start: all pools with their folders and files, apps, network-share users and backups.
      Your ApexOs account and its connection to TrueNAS stay.
    </p>
    <div>
      <button class="btn danger" @click="start"><Eraser :size="16" aria-hidden="true" /> Erase everything…</button>
    </div>
  </section>

  <Modal v-if="open" title="Erase everything and start over?" wide @close="open = false">
    <div v-if="runner.task.value" class="stack" style="--gap: 12px" aria-live="polite">
      <div class="card flat"><TaskItem :task="runner.task.value" show-steps /></div>
      <p v-if="runner.task.value.status === 'running'" class="small muted">Don’t turn the server off. Setup starts as soon as this finishes.</p>
    </div>
    <p v-else-if="loadError" class="callout err">{{ loadError }}</p>
    <div v-else-if="!preview" class="row muted" role="status"><span class="spin" /> Looking at what’s on your server…</div>

    <div v-else-if="preview.blockers.length" class="stack" style="--gap: 12px">
      <p>Your server can’t be erased right now:</p>
      <ul class="blockers">
        <li v-for="b in preview.blockers" :key="b.code + b.message" class="row" style="--gap: 10px">
          <TriangleAlert :size="16" class="warn-icon" />
          <span>{{ b.message }}</span>
        </li>
      </ul>
    </div>

    <form v-else id="reset-form" class="stack" style="--gap: 16px" @submit.prevent="erase">
      <div class="callout err stack" style="--gap: 6px">
        <strong>This erases for good, and can’t be undone.</strong>
        <ul class="gone small">
          <li v-if="preview.pools.length">
            Pools: {{ list(preview.pools.map((p) => `${p.displayName} (${formatBytes(p.usedBytes)})`)) }}, with every folder, file and restore point on them
          </li>
          <li v-else>There are no pools.</li>
          <li v-if="preview.apps.length">Apps: {{ list(preview.apps) }}</li>
          <li v-if="preview.users.length">Network-share users: {{ list(preview.users) }}</li>
          <li v-if="preview.backups.length">Backups to {{ list(preview.backups) }} (the copies there too, when that server is on)</li>
          <li v-if="preview.hostsBackups">Backups other servers keep here</li>
        </ul>
        <span class="small">If ApexOs itself runs on this server (for example in a container on one of its pools), it is erased too.</span>
      </div>
      <p class="small muted">Kept: your ApexOs account and two-factor sign-in, the connection to TrueNAS, the server’s name, time zone and network settings.</p>

      <div class="field">
        <label for="rs-confirm">Type <strong>{{ preview.confirmText }}</strong> to confirm</label>
        <input id="rs-confirm" v-model="confirm" type="text" autocomplete="off" spellcheck="false" />
      </div>
      <div class="field">
        <label for="rs-password">Your password</label>
        <input id="rs-password" v-model="password" type="password" autocomplete="current-password" />
      </div>
      <div v-if="preview.needsCode" class="field">
        <label for="rs-code">{{ recovery ? 'Recovery code' : 'Code from your authenticator app' }}</label>
        <CodeInput id="rs-code" v-model="code" :recovery="recovery" style="max-width: 200px" />
        <button type="button" class="btn ghost small link-btn" @click="(recovery = !recovery), (code = '')">
          {{ recovery ? 'Use a code from my authenticator app' : 'Use a recovery code instead' }}
        </button>
      </div>
      <p v-if="runner.error.value" class="callout err" role="alert">{{ runner.error.value }}</p>
    </form>

    <template #footer>
      <button v-if="runner.task.value" class="btn" :disabled="runner.task.value.status === 'running'" @click="open = false">Close</button>
      <template v-else>
        <button class="btn" @click="open = false">{{ preview?.blockers.length ? 'OK' : 'Cancel' }}</button>
        <button v-if="preview && !preview.blockers.length" type="submit" form="reset-form" class="btn danger solid" :disabled="!canErase">
          <span v-if="runner.running.value" class="spin" />Erase everything
        </button>
      </template>
    </template>
  </Modal>
</template>

<style scoped>
.blockers,
.gone {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.blockers {
  list-style: none;
  padding: 0;
}
.gone {
  padding-left: 18px;
  gap: 4px;
}
.blockers li {
  align-items: flex-start;
}
.warn-icon {
  flex: none;
  margin-top: 2px;
  color: var(--warn);
}
.link-btn {
  align-self: flex-start;
  padding-left: 0;
}
</style>
