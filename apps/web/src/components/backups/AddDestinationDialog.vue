<script setup lang="ts">
/**
 * Adds another TrueNAS server as a backup destination: sign in once (password or API key), then pick
 * a pool and how much space to set aside there. ApexOs sets up both servers as one task.
 */
import { computed, nextTick, reactive, ref } from 'vue';
import { Network, Server } from 'lucide-vue-next';
import type { DestinationCheck, DestinationCredentials, TaskStarted } from '@apexos/api-types';
import Modal from '../Modal.vue';
import PasswordInput from '../users/PasswordInput.vue';
import TaskProgress from '../storage/TaskProgress.vue';
import { useTaskRunner } from '../storage/taskRunner.ts';
import { ApiError, api } from '../../lib/api.ts';
import { formatBytes } from '../../lib/format.ts';
import { NETWORK_NOTE, sizeToBytes, splitSize } from './backups.ts';

const emit = defineEmits<{ close: []; done: [] }>();

type Method = DestinationCredentials['method'];
const address = ref('');
const method = ref<Method>('password');
const username = ref('truenas_admin');
const password = ref('');
const apiKey = ref('');
const fields = reactive<Record<string, string>>({});
const error = ref<string | null>(null);
const checking = ref(false);
const check = ref<DestinationCheck | null>(null);

const pool = ref('');
const space = ref(100);
const unit = ref<'GB' | 'TB'>('GB');

const runner = useTaskRunner(() => emit('done'));

function credentials(): DestinationCredentials {
  return method.value === 'password'
    ? { address: address.value.trim(), method: 'password', username: username.value.trim(), password: password.value }
    : { address: address.value.trim(), method: 'apiKey', apiKey: apiKey.value.trim() };
}

function validate(): boolean {
  for (const k of Object.keys(fields)) delete fields[k];
  const a = address.value.trim();
  if (!a) fields.address = 'Enter the other server’s IP address or name.';
  else if (/\s/.test(a)) fields.address = 'The address can’t contain spaces.';
  if (method.value === 'password') {
    if (!username.value.trim()) fields.username = 'Enter the TrueNAS admin username.';
    if (!password.value) fields.password = 'Enter the password for that account.';
  } else if (apiKey.value.trim().length < 10) fields.apiKey = 'Paste the whole API key.';
  return !Object.keys(fields).length;
}

async function connect() {
  error.value = null;
  if (!validate()) return;
  checking.value = true;
  try {
    const result = await api.post<DestinationCheck>('/backups/destinations/check', credentials());
    check.value = result;
    const first = result.pools.filter((p) => p.usable).sort((x, y) => y.freeBytes - x.freeBytes)[0];
    pool.value = first?.name ?? '';
    suggest();
    await nextTick();
    document.getElementById('ad-pool-heading')?.focus();
  } catch (e) {
    if (e instanceof ApiError) {
      Object.assign(fields, e.fields);
      error.value = e.message;
    } else error.value = String(e);
  } finally {
    checking.value = false;
  }
}

const chosen = computed(() => check.value?.pools.find((p) => p.name === pool.value) ?? null);
const spaceBytes = computed(() => sizeToBytes(Number(space.value) || 0, unit.value));

/** Suggests the size of this server's folders plus a fifth for restore points, within the pool's free space. */
function suggest() {
  const free = chosen.value?.freeBytes ?? 0;
  const wanted = Math.max(100e9, (check.value?.foldersBytes ?? 0) * 1.2);
  const s = splitSize(Math.min(wanted, free * 0.9));
  space.value = s.value;
  unit.value = s.unit;
}

const spaceProblem = computed(() => {
  if (!chosen.value) return 'Pick a pool.';
  if (!Number.isFinite(spaceBytes.value) || spaceBytes.value < 1e9) return 'Set aside at least 1 GB.';
  if (spaceBytes.value > chosen.value.freeBytes) return `${chosen.value.name} has only ${formatBytes(chosen.value.freeBytes)} free.`;
  return null;
});

function add() {
  if (spaceProblem.value || !check.value) return;
  void runner.start(api.post<TaskStarted>('/backups/destinations', { ...credentials(), pool: pool.value, spaceBytes: spaceBytes.value }));
}

function back() {
  check.value = null;
  runner.error.value = null;
}
</script>

<template>
  <Modal :title="check ? `Use ${check.name} for backups` : 'Add a backup destination'" wide @close="emit('close')">
    <template v-if="!check">
      <p>Pick another TrueNAS server you own to keep copies of your folders, so a broken server, a lost pool or a mistake doesn’t cost you your files.</p>
      <p class="callout row" style="--gap: 10px; align-items: flex-start"><Network :size="18" class="note-icon" aria-hidden="true" /><span>{{ NETWORK_NOTE }}</span></p>

      <form id="ad-connect" class="stack" novalidate autocomplete="off" @submit.prevent="connect">
        <div class="field">
          <label for="ad-address">Address of the other server</label>
          <input
            id="ad-address"
            v-model="address"
            type="text"
            inputmode="url"
            autocapitalize="off"
            spellcheck="false"
            placeholder="192.168.1.30, backup-nas.local or a Tailscale name"
            :aria-invalid="!!fields.address || undefined"
            aria-describedby="ad-address-hint"
            @input="delete fields.address"
          />
          <span id="ad-address-hint" class="hint">The IP address or name you use to open its TrueNAS web page. ApexOs connects over HTTPS.</span>
          <span v-if="fields.address" class="error-text">{{ fields.address }}</span>
        </div>

        <fieldset class="stack plain" style="--gap: 10px">
          <legend class="field-label">Sign in to it once</legend>
          <div class="row wrap" style="--gap: 16px">
            <label class="row" style="--gap: 8px"><input v-model="method" type="radio" value="password" /> Admin password</label>
            <label class="row" style="--gap: 8px"><input v-model="method" type="radio" value="apiKey" /> API key</label>
          </div>
          <template v-if="method === 'password'">
            <p class="small muted">ApexOs uses the password once to create its own key on that server. The password isn’t stored.</p>
            <div class="row wrap two" style="--gap: 12px">
              <div class="field">
                <label for="ad-user">TrueNAS admin username</label>
                <input id="ad-user" v-model="username" type="text" autocapitalize="off" spellcheck="false" data-1p-ignore data-lpignore="true" :aria-invalid="!!fields.username || undefined" />
                <span v-if="fields.username" class="error-text">{{ fields.username }}</span>
              </div>
              <div class="field">
                <label for="ad-pass">Password</label>
                <PasswordInput id="ad-pass" v-model="password" autocomplete="off" :invalid="!!fields.password" @input="delete fields.password" />
                <span v-if="fields.password" class="error-text">{{ fields.password }}</span>
              </div>
            </div>
          </template>
          <div v-else class="field">
            <label for="ad-key">API key of the other server</label>
            <PasswordInput id="ad-key" v-model="apiKey" autocomplete="off" :invalid="!!fields.apiKey" describedby="ad-key-hint" @input="delete fields.apiKey" />
            <span id="ad-key-hint" class="hint">Create one in that server’s TrueNAS web page under Credentials → Users, for its admin account.</span>
            <span v-if="fields.apiKey" class="error-text">{{ fields.apiKey }}</span>
          </div>
        </fieldset>
        <p v-if="error" class="callout err" role="alert">{{ error }}</p>
      </form>
    </template>

    <template v-else>
      <div class="row server" style="--gap: 12px">
        <Server :size="22" class="note-icon" aria-hidden="true" />
        <div class="stack" style="--gap: 0">
          <strong>{{ check.name }}</strong>
          <span class="small muted">TrueNAS {{ check.version }} · {{ check.address }}</span>
        </div>
      </div>

      <fieldset class="stack plain" style="--gap: 8px" :disabled="runner.running.value">
        <legend id="ad-pool-heading" tabindex="-1" class="field-label">Where should the copies go?</legend>
        <label v-for="p in check.pools" :key="p.name" class="pool card flat" :class="{ off: !p.usable, on: pool === p.name }">
          <input v-model="pool" type="radio" name="ad-pool" :value="p.name" :disabled="!p.usable" @change="suggest" />
          <span class="stack" style="--gap: 2px; min-width: 0">
            <strong>{{ p.name }}</strong>
            <span class="small muted">{{ formatBytes(p.freeBytes) }} free</span>
            <span v-if="p.note" class="small" :class="p.usable ? 'muted' : 'warn-text'">{{ p.note }}</span>
          </span>
        </label>
      </fieldset>

      <div class="field">
        <label for="ad-space">Space to set aside for this server’s backups</label>
        <div class="row" style="--gap: 8px">
          <input id="ad-space" v-model.number="space" class="space" type="number" min="1" step="1" :disabled="runner.running.value" :aria-invalid="!!spaceProblem || undefined" aria-describedby="ad-space-hint" />
          <select v-model="unit" class="unit" aria-label="Unit" :disabled="runner.running.value">
            <option value="GB">GB</option>
            <option value="TB">TB</option>
          </select>
        </div>
        <span id="ad-space-hint" class="hint">
          It’s reserved on {{ check.name }} right away, so the backups always have room and can never fill up its pool. Your folders use
          {{ formatBytes(check.foldersBytes) }} today; leave extra room for restore points. You can change it later.
        </span>
        <span v-if="spaceProblem" class="error-text">{{ spaceProblem }}</span>
      </div>

      <div class="callout small stack" style="--gap: 6px">
        <strong>What ApexOs sets up on {{ check.name }}</strong>
        <ul class="setup">
          <li>A backup account that can only receive copies: no password, it signs in with a key that only this server has.</li>
          <li>A space of {{ formatBytes(spaceBytes) }} on {{ chosen?.name ?? 'the pool' }}, in a dataset called <code>apexos-backups</code>.</li>
          <li v-if="!check.sshEnabled">SSH, which TrueNAS uses to send the copies. It’s turned off again if you remove this destination.</li>
        </ul>
      </div>

      <TaskProgress v-if="runner.task.value" :task="runner.task.value" label="Setting up both servers" />
      <p v-if="runner.error.value" class="callout err" role="alert">{{ runner.error.value }}</p>
    </template>

    <template #footer>
      <button class="btn" type="button" @click="emit('close')">Cancel</button>
      <template v-if="!check">
        <button class="btn primary" type="submit" form="ad-connect" :disabled="checking"><span v-if="checking" class="spin" />{{ checking ? 'Connecting…' : 'Continue' }}</button>
      </template>
      <template v-else>
        <button class="btn" type="button" :disabled="runner.running.value" @click="back">Back</button>
        <button class="btn primary" type="button" :disabled="!!spaceProblem || runner.running.value" @click="add">
          <span v-if="runner.running.value" class="spin" />{{ runner.running.value ? 'Setting up…' : 'Add destination' }}
        </button>
      </template>
    </template>
  </Modal>
</template>

<style scoped>
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
.two > .field {
  flex: 1 1 200px;
  min-width: 0;
}
.note-icon {
  color: var(--info);
  flex-shrink: 0;
  margin-top: 2px;
}
.server .note-icon {
  color: var(--accent);
}
.pool {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 14px;
  cursor: pointer;
}
.pool input {
  margin-top: 3px;
}
.pool.on {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.pool.off {
  cursor: not-allowed;
  opacity: 0.7;
}
.warn-text {
  color: var(--warn);
}
.space {
  max-width: 140px;
}
.unit {
  width: auto;
}
.setup {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
</style>
