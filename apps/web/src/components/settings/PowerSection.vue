<script setup lang="ts">
/** Restart / shut down the server, with a risk acknowledgement when a pool is unhealthy. */
import { computed, onMounted, ref } from 'vue';
import { Power, RotateCcw } from 'lucide-vue-next';
import type { PowerRequest, UpdateInfo } from '@apexos/api-types';
import ConfirmDialog from '../ConfirmDialog.vue';
import { ApiError, api } from '../../lib/api.ts';
import { onServerChange } from '../../lib/events.ts';

type Action = PowerRequest['action'];

const riskWarning = ref<string | null>(null);
async function loadRisk() {
  try {
    riskWarning.value = (await api.get<UpdateInfo>('/system/update')).riskWarning;
  } catch {
    // The server re-checks the risk itself and answers RISK_NOT_ACKNOWLEDGED if needed.
  }
}
onMounted(loadRisk);
onServerChange(['storage'], loadRisk);

const action = ref<Action | null>(null);
const busy = ref(false);
const error = ref<string | null>(null);
const done = ref<Action | null>(null);
const back = ref(false);

// After a restart, TrueNAS reconnecting means the server is back.
onServerChange(['truenas-connected'], () => {
  if (done.value !== 'restart') return;
  done.value = null;
  back.value = true;
  loadRisk();
});

const copy = computed(() =>
  action.value === 'shutdown'
    ? {
        title: 'Shut down the server?',
        message: 'Everything on the server stops: apps, shared folders and ApexOs itself. To turn it back on, press the power button on the server.',
        label: 'Shut down',
      }
    : {
        title: 'Restart the server?',
        message: 'Apps, shared folders and ApexOs itself are unavailable for a few minutes while the server restarts. Everything comes back on its own.',
        label: 'Restart',
      },
);

function open(a: Action) {
  error.value = null;
  action.value = a;
}

async function confirm() {
  if (!action.value) return;
  busy.value = true;
  error.value = null;
  try {
    await api.post('/system/power', { action: action.value, acknowledgeRisk: !!riskWarning.value } satisfies PowerRequest);
    done.value = action.value;
    back.value = false;
    action.value = null;
  } catch (e) {
    if (e instanceof ApiError && e.code === 'RISK_NOT_ACKNOWLEDGED') riskWarning.value = e.message;
    else error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="card stack" aria-labelledby="pw-h">
    <h2 id="pw-h">Power</h2>
    <p class="muted small">Restart the server if something seems stuck, or shut it down before moving it or changing hardware.</p>
    <p v-if="done === 'restart'" class="callout ok" role="status">
      Your server is restarting. This page reconnects by itself when it’s back, usually within a few minutes.
    </p>
    <p v-else-if="done === 'shutdown'" class="callout ok" role="status">
      Your server is shutting down. You can close this page. Press the server’s power button to start it again.
    </p>
    <p v-else-if="back" class="callout ok" role="status">Your server is back online.</p>
    <p v-if="riskWarning && !done" class="callout warn small">{{ riskWarning }}</p>
    <div class="row wrap" style="--gap: 10px">
      <button class="btn" :disabled="!!done" @click="open('restart')"><RotateCcw :size="16" /> Restart</button>
      <button class="btn danger" :disabled="!!done" @click="open('shutdown')"><Power :size="16" /> Shut down</button>
    </div>
  </section>

  <ConfirmDialog
    v-if="action"
    :key="`${action}-${riskWarning ?? ''}`"
    :title="copy.title"
    :message="copy.message"
    :action-label="copy.label"
    :danger="action === 'shutdown'"
    :checkbox="riskWarning ? 'I understand the risk and want to continue anyway.' : undefined"
    :busy="busy"
    :error="error"
    @confirm="confirm"
    @close="action = null"
  >
    <p v-if="riskWarning" class="callout warn">{{ riskWarning }}</p>
  </ConfirmDialog>
</template>
