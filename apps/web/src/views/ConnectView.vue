<script setup lang="ts">
import { computed, nextTick, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { ConnectRequest } from '@apexos/api-types';
import OnboardingFrame from '../components/OnboardingFrame.vue';
import PasswordInput from '../components/users/PasswordInput.vue';
import { ApiError, api, refreshStatus, session } from '../lib/api.ts';

type Method = ConnectRequest['method'];

const router = useRouter();
const method = ref<Method>('password');
const host = ref('');
const username = ref('truenas_admin');
const password = ref('');
const apiKey = ref('');
const fields = reactive<Record<string, string>>({});
const error = ref('');
const busy = ref(false);

const retrying = ref(false);
const retryError = ref('');

const tabs: { id: Method; label: string }[] = [
  { id: 'password', label: 'Admin password' },
  { id: 'apiKey', label: 'API key' },
];

function selectTab(id: Method, focus = false) {
  method.value = id;
  error.value = '';
  if (focus) nextTick(() => document.getElementById(`tab-${id}`)?.focus());
}

function onTabKey(e: KeyboardEvent) {
  const i = tabs.findIndex((t) => t.id === method.value);
  let next = -1;
  if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
  else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = tabs.length - 1;
  if (next < 0) return;
  e.preventDefault();
  selectTab(tabs[next]!.id, true);
}

function validate(): boolean {
  for (const k of Object.keys(fields)) delete fields[k];
  const h = host.value.trim();
  if (!h) fields.host = 'Enter your server’s IP address or hostname.';
  else if (/^http:\/\//i.test(h)) fields.host = 'ApexOs only connects over HTTPS. Enter just the address, for example 192.168.1.20.';
  else if (/\s/.test(h)) fields.host = 'The address can’t contain spaces.';
  if (method.value === 'password') {
    if (!username.value.trim()) fields.username = 'Enter the TrueNAS admin username.';
    if (!password.value) fields.password = 'Enter the password for that account.';
  } else if (apiKey.value.trim().length < 10) {
    fields.apiKey = apiKey.value.trim() ? 'That looks too short to be a full API key. Copy the whole key.' : 'Paste the API key.';
  }
  return !Object.keys(fields).length;
}

const firstInvalid = computed(() => ['host', 'username', 'password', 'apiKey'].find((k) => fields[k]));

async function submit() {
  error.value = '';
  if (!validate()) {
    await nextTick();
    const id = { host: 'cx-host', username: 'cx-user', password: 'cx-pass', apiKey: 'cx-key' }[firstInvalid.value ?? 'host'];
    if (id) document.getElementById(id)?.focus();
    return;
  }
  const body: ConnectRequest =
    method.value === 'password'
      ? { host: host.value.trim(), method: 'password', username: username.value.trim(), password: password.value }
      : { host: host.value.trim(), method: 'apiKey', apiKey: apiKey.value.trim() };
  busy.value = true;
  try {
    await api.post('/truenas/connect', body);
    password.value = '';
    await refreshStatus();
    router.replace(session.setupComplete ? '/' : '/setup');
  } catch (e) {
    if (e instanceof ApiError) {
      Object.assign(fields, e.fields);
      error.value = e.message;
    } else error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function retry() {
  retrying.value = true;
  retryError.value = '';
  try {
    await api.post('/truenas/reconnect');
    await refreshStatus();
    if (session.truenasConnected) router.replace(session.setupComplete ? '/' : '/setup');
    else retryError.value = 'Still can’t reach TrueNAS. Check that the server is switched on and connected to your network.';
  } catch (e) {
    retryError.value = e instanceof ApiError ? e.message : String(e);
  } finally {
    retrying.value = false;
  }
}

/** Plain-language reading of common connection failures; the raw message is still shown as a detail. */
const friendly = computed(() => {
  const m = error.value;
  if (!m) return null;
  if (/ECONNREFUSED/i.test(m)) return 'Nothing answered at that address. Check the IP address or hostname, and that TrueNAS has finished starting.';
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(m)) return 'That hostname couldn’t be found on your network. Try the server’s IP address instead.';
  if (/timed out|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/i.test(m)) return 'The server didn’t respond. Check that it’s switched on and connected to the same network as ApexOs.';
  if (/OTP|two-factor|2FA/i.test(m)) return 'This account uses two-factor sign-in. Use the API key option instead.';
  if (/credential|password|unauthori[sz]ed|401|denied|EXPIRED|revoked/i.test(m)) {
    return method.value === 'password' ? 'TrueNAS didn’t accept that username and password.' : 'TrueNAS didn’t accept that API key. It may have been deleted or revoked; create a new one.';
  }
  return null;
});

const disconnected = computed(() => session.truenasConfigured && !session.truenasConnected);
</script>

<template>
  <OnboardingFrame
    :title="disconnected ? 'Reconnect to your server' : 'Connect your server'"
    subtitle="ApexOs manages your server through TrueNAS SCALE 25.10 or newer."
    width="min(540px, 100%)"
  >
    <div v-if="disconnected" class="callout warn stack" style="--gap: 10px" role="status">
      <span>
        ApexOs can’t reach TrueNAS right now. Check that the server is switched on and connected, then try again. If its address or
        password changed, enter the new details below.
      </span>
      <div class="row wrap" style="--gap: 10px">
        <button class="btn small" :disabled="retrying" @click="retry"><span v-if="retrying" class="spin" />Try again</button>
        <span v-if="retryError" class="small" style="color: var(--err)">{{ retryError }}</span>
      </div>
    </div>

    <form class="stack" novalidate autocomplete="off" @submit.prevent="submit">
      <div class="field">
        <label for="cx-host">Server address</label>
        <input
          id="cx-host"
          v-model="host"
          type="text"
          inputmode="url"
          autocapitalize="off"
          spellcheck="false"
          autocomplete="off"
          placeholder="192.168.1.20 or truenas.local"
          :aria-invalid="!!fields.host || undefined"
          aria-describedby="cx-host-hint cx-host-err"
          @input="delete fields.host"
        />
        <span id="cx-host-hint" class="hint">
          The IP address or hostname of your TrueNAS server (the same one you type to open its web page). ApexOs always connects over HTTPS and accepts the
          self-signed certificate TrueNAS comes with.
        </span>
        <span v-if="fields.host" id="cx-host-err" class="error-text">{{ fields.host }}</span>
      </div>

      <div class="stack" style="--gap: 12px">
        <span class="field-label" id="cx-method-label">How should ApexOs sign in?</span>
        <div class="tabs" role="tablist" aria-labelledby="cx-method-label">
          <button
            v-for="t in tabs"
            :id="`tab-${t.id}`"
            :key="t.id"
            type="button"
            role="tab"
            class="tab"
            :class="{ on: method === t.id }"
            :aria-selected="method === t.id"
            :aria-controls="`panel-${t.id}`"
            :tabindex="method === t.id ? 0 : -1"
            @click="selectTab(t.id)"
            @keydown="onTabKey"
          >
            {{ t.label }}
          </button>
        </div>

        <div v-if="method === 'password'" id="panel-password" role="tabpanel" aria-labelledby="tab-password" class="stack panel">
          <p class="small muted">
            ApexOs signs in with your TrueNAS admin account once to create its own API key, then forgets the password. It’s never stored.
          </p>
          <div class="field">
            <label for="cx-user">TrueNAS admin username</label>
            <input
              id="cx-user"
              v-model="username"
              type="text"
              autocapitalize="off"
              spellcheck="false"
              autocomplete="off"
              data-1p-ignore
              data-lpignore="true"
              :aria-invalid="!!fields.username || undefined"
              @input="delete fields.username"
            />
            <span class="hint">New TrueNAS installs use <code>truenas_admin</code>.</span>
            <span v-if="fields.username" class="error-text">{{ fields.username }}</span>
          </div>
          <div class="field">
            <label for="cx-pass">Password</label>
            <PasswordInput id="cx-pass" v-model="password" autocomplete="off" :invalid="!!fields.password" @input="delete fields.password" />
            <span class="hint">If this account uses two-factor sign-in, use an API key instead.</span>
            <span v-if="fields.password" class="error-text">{{ fields.password }}</span>
          </div>
        </div>

        <div v-else id="panel-apiKey" role="tabpanel" aria-labelledby="tab-apiKey" class="stack panel">
          <p class="small muted">
            In the TrueNAS web interface, go to <em>Credentials → Users</em>, open your admin user and add an API key. Copy it straight away: TrueNAS shows it
            only once.
          </p>
          <div class="field">
            <label for="cx-key">API key</label>
            <PasswordInput id="cx-key" v-model="apiKey" autocomplete="off" :invalid="!!fields.apiKey" @input="delete fields.apiKey" />
            <span v-if="fields.apiKey" class="error-text">{{ fields.apiKey }}</span>
          </div>
        </div>
      </div>

      <div v-if="error" class="callout err stack" style="--gap: 6px" role="alert">
        <strong>{{ Object.keys(fields).length ? error : (friendly ?? 'ApexOs couldn’t connect to TrueNAS.') }}</strong>
        <span v-if="!friendly && !Object.keys(fields).length" class="small">
          Check the address, that the server is on and reachable from where ApexOs runs, and that the
          {{ method === 'password' ? 'username and password are' : 'API key is' }} right.
        </span>
        <span v-if="!Object.keys(fields).length" class="small muted detail">Details: {{ error }}</span>
      </div>

      <button class="btn primary" :disabled="busy">
        <span v-if="busy" class="spin" />
        {{ busy ? 'Connecting…' : 'Connect' }}
      </button>
    </form>
  </OnboardingFrame>
</template>

<style scoped>
.tabs {
  display: flex;
  gap: 2px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 3px;
}
.tab {
  flex: 1;
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  font-weight: 550;
  font-size: 0.92rem;
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
}
.tab.on {
  background: var(--surface);
  color: var(--text);
  box-shadow: var(--shadow);
}
.tab:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.panel {
  --gap: 14px;
}
.detail {
  overflow-wrap: anywhere;
}
</style>
