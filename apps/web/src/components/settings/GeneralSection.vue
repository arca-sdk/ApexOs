<script setup lang="ts">
/** Server name (existing behaviour) and the server's time zone. */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { TimezoneInfo } from '@hearth/api-types';
import { ApiError, api, refreshStatus } from '../../lib/api.ts';
import { onServerChange } from '../../lib/events.ts';

interface SettingsResponse {
  serverName: string;
  truenas: { url: string | null; connected: boolean; version: string | null };
}

// ---- server name ----
const serverName = ref('');
const nameMsg = ref('');
const nameErr = ref('');
const nameBusy = ref(false);
const nameLoadErr = ref('');

async function loadName() {
  nameLoadErr.value = '';
  try {
    serverName.value = (await api.get<SettingsResponse>('/settings')).serverName;
  } catch (e) {
    nameLoadErr.value = e instanceof Error ? e.message : String(e);
  }
}

async function saveName() {
  nameMsg.value = nameErr.value = '';
  nameBusy.value = true;
  try {
    await api.put('/settings/server-name', { name: serverName.value });
    await refreshStatus();
    nameMsg.value = 'Saved.';
  } catch (e) {
    nameErr.value = e instanceof ApiError ? (e.fields.name ?? e.message) : String(e);
  } finally {
    nameBusy.value = false;
  }
}

// ---- time zone ----
const tz = ref<TimezoneInfo | null>(null);
const tzChoice = ref('');
const tzErr = ref('');
const tzMsg = ref('');
const tzLoadErr = ref('');
const tzBusy = ref(false);

async function loadTz() {
  tzLoadErr.value = '';
  try {
    tz.value = await api.get<TimezoneInfo>('/system/timezone');
    tzChoice.value = tz.value.timezone;
  } catch (e) {
    tzLoadErr.value = e instanceof Error ? e.message : String(e);
  }
}

/** Choices grouped by region ("Europe/Paris" → Europe) for an easier-to-scan list. */
const groups = computed(() => {
  const map = new Map<string, string[]>();
  for (const c of tz.value?.choices ?? []) {
    const region = c.includes('/') ? c.split('/')[0]! : 'Other';
    if (!map.has(region)) map.set(region, []);
    map.get(region)!.push(c);
  }
  return [...map.entries()].sort(([a], [b]) => (a === 'Other' ? 1 : b === 'Other' ? -1 : a.localeCompare(b)));
});

function prettyZone(zone: string): string {
  return zone.split('/').join(' / ').replace(/_/g, ' ');
}

const now = ref(Date.now());
const clock = setInterval(() => (now.value = Date.now()), 30_000);
onBeforeUnmount(() => clearInterval(clock));

const localTime = computed(() => {
  if (!tzChoice.value) return null;
  try {
    return new Date(now.value).toLocaleTimeString(undefined, { timeZone: tzChoice.value, hour: '2-digit', minute: '2-digit' });
  } catch {
    return null;
  }
});

async function saveTz() {
  tzErr.value = tzMsg.value = '';
  tzBusy.value = true;
  try {
    await api.put('/system/timezone', { timezone: tzChoice.value });
    if (tz.value) tz.value.timezone = tzChoice.value;
    tzMsg.value = 'Saved.';
  } catch (e) {
    tzErr.value = e instanceof ApiError ? (e.fields.timezone ?? e.message) : String(e);
  } finally {
    tzBusy.value = false;
  }
}

onMounted(() => {
  loadName();
  loadTz();
});
onServerChange(['system'], loadName);
</script>

<template>
  <div class="stack" style="--gap: 20px">
    <section class="card stack" aria-labelledby="gs-name">
      <h2 id="gs-name">Server name</h2>
      <p class="muted small">Shown on your network, for example when you open shared folders from another computer.</p>
      <p v-if="nameLoadErr" class="callout warn">
        Couldn’t load the current name: {{ nameLoadErr }} <button class="btn small" @click="loadName">Try again</button>
      </p>
      <form class="row wrap" @submit.prevent="saveName">
        <label for="gs-name-input" class="sr-only">Server name</label>
        <input id="gs-name-input" v-model="serverName" type="text" maxlength="15" autocomplete="off" style="max-width: 320px" />
        <button class="btn primary" :disabled="nameBusy"><span v-if="nameBusy" class="spin" />Save</button>
        <span v-if="nameMsg" class="badge ok" role="status">{{ nameMsg }}</span>
      </form>
      <p class="hint small muted">2 to 15 letters, numbers or dashes, starting with a letter.</p>
      <p v-if="nameErr" class="callout err" role="alert">{{ nameErr }}</p>
    </section>

    <section class="card stack" aria-labelledby="gs-tz">
      <h2 id="gs-tz">Time zone</h2>
      <p class="muted small">Used for schedules such as health checks and for the times shown in notifications.</p>
      <p v-if="tzLoadErr" class="callout warn">
        Couldn’t load time zones: {{ tzLoadErr }} <button class="btn small" @click="loadTz">Try again</button>
      </p>
      <div v-else-if="!tz" class="row muted"><span class="spin" /> Loading…</div>
      <form v-else class="stack" style="--gap: 10px" @submit.prevent="saveTz">
        <div class="field" style="max-width: 420px">
          <label for="gs-tz-select">Time zone</label>
          <select id="gs-tz-select" v-model="tzChoice" @change="tzMsg = ''">
            <optgroup v-for="[region, zones] in groups" :key="region" :label="region.replace(/_/g, ' ')">
              <option v-for="z in zones" :key="z" :value="z">{{ prettyZone(z) }}</option>
            </optgroup>
          </select>
          <span v-if="localTime" class="hint">It’s {{ localTime }} there now.</span>
        </div>
        <div class="row" style="--gap: 10px">
          <button class="btn primary" :disabled="tzBusy || tzChoice === tz.timezone"><span v-if="tzBusy" class="spin" />Save</button>
          <span v-if="tzMsg" class="badge ok" role="status">{{ tzMsg }}</span>
        </div>
        <p v-if="tzErr" class="callout err" role="alert">{{ tzErr }}</p>
      </form>
    </section>
  </div>
</template>

<style scoped>
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
</style>
