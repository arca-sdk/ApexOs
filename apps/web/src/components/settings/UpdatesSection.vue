<script setup lang="ts">
/** TrueNAS version, support status and updates (with progress from the server task). */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { CircleCheck, CircleX, ExternalLink, RefreshCw } from 'lucide-vue-next';
import type { TaskStarted, UpdateInfo } from '@hearth/api-types';
import ConfirmDialog from '../ConfirmDialog.vue';
import PageState from '../PageState.vue';
import { ApiError, api } from '../../lib/api.ts';
import { live, onServerChange } from '../../lib/events.ts';

const info = ref<UpdateInfo | null>(null);
const loading = ref(true);
const checking = ref(false);
const error = ref<string | null>(null);

async function load() {
  error.value = null;
  try {
    info.value = await api.get<UpdateInfo>('/system/update');
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}
async function checkAgain() {
  checking.value = true;
  await load();
  checking.value = false;
}
function retry() {
  loading.value = true;
  load();
}
onMounted(load);
onServerChange(['system', 'storage', 'truenas-connected'], load);

// ---- running update ----
const taskId = ref<string | null>(null);
const task = computed(() => {
  if (taskId.value && live.tasks[taskId.value]) return live.tasks[taskId.value]!;
  const tasks = Object.values(live.tasks).filter((t) => t.type === 'system-update');
  return tasks.find((t) => t.status === 'running') ?? null;
});
const running = computed(() => task.value?.status === 'running');

// When the update finishes, refresh the version info now and again once the restart is likely over.
let later: ReturnType<typeof setTimeout> | undefined;
watch(
  () => task.value?.status,
  (status, previous) => {
    if (previous !== 'running' || status === 'running') return;
    load();
    clearTimeout(later);
    later = setTimeout(load, 20_000);
  },
);
onBeforeUnmount(() => clearTimeout(later));

// ---- confirm ----
const confirming = ref(false);
const busy = ref(false);
const startError = ref<string | null>(null);

function openConfirm() {
  startError.value = null;
  confirming.value = true;
}

async function start() {
  if (!info.value) return;
  busy.value = true;
  startError.value = null;
  try {
    const { task: t } = await api.post<TaskStarted>('/system/update', { acknowledgeRisk: !!info.value.riskWarning });
    live.tasks[t.id] ??= t;
    taskId.value = t.id;
    confirming.value = false;
  } catch (e) {
    if (e instanceof ApiError && e.code === 'RISK_NOT_ACKNOWLEDGED') {
      // A pool became unhealthy since the page loaded: show the warning and ask again.
      info.value = { ...info.value, riskWarning: e.message };
    } else startError.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

function stepIcon(status: string) {
  return status === 'success' ? '✓' : status === 'failed' ? '✕' : status === 'running' ? '…' : '';
}
</script>

<template>
  <section class="card stack" aria-labelledby="us-h">
    <div class="row wrap">
      <h2 id="us-h">Updates</h2>
      <span class="spacer" />
      <button v-if="info && !running" class="btn small" :disabled="checking" @click="checkAgain">
        <span v-if="checking" class="spin" /><RefreshCw v-else :size="14" /> Check again
      </button>
    </div>
    <PageState :loading="loading" :error="error" @retry="retry">
      <div v-if="info" class="stack" style="--gap: 14px">
        <div class="row wrap" style="--gap: 10px">
          <span>TrueNAS <strong>{{ info.currentVersion }}</strong></span>
          <span v-if="info.supported" class="badge ok"><CircleCheck :size="12" /> Supported by Hearth</span>
          <span v-else class="badge warn"><CircleX :size="12" /> Not supported</span>
        </div>
        <p v-if="!info.supported" class="callout warn">
          {{ info.supportNote ?? 'Hearth hasn’t been tested with this TrueNAS version. Some things may not work.' }}
        </p>

        <!-- progress of a running (or just finished) update -->
        <div v-if="task" class="card flat stack progress" style="--gap: 10px" aria-live="polite">
          <div class="row" style="--gap: 10px">
            <span v-if="task.status === 'running'" class="spin" style="color: var(--accent)" />
            <CircleCheck v-else-if="task.status === 'success'" :size="18" style="color: var(--ok)" />
            <CircleX v-else :size="18" style="color: var(--err)" />
            <strong>{{ task.title }}</strong>
          </div>
          <template v-if="task.status === 'running'">
            <p class="small muted">{{ task.message || 'Working…' }}</p>
            <div class="meter" role="progressbar" :aria-valuenow="Math.round(task.progress)" aria-valuemin="0" aria-valuemax="100" aria-label="Update progress">
              <span :style="{ width: `${task.progress}%` }" />
            </div>
            <ol class="steps small">
              <li v-for="s in task.steps" :key="s.name" :class="s.status">
                <span class="mark" aria-hidden="true">{{ stepIcon(s.status) }}</span> {{ s.name }}
              </li>
            </ol>
            <p class="small muted">You can leave this page. The server restarts by itself when the update is installed.</p>
          </template>
          <p v-else-if="task.status === 'success'" class="small">The update is installed and your server is restarting. Hearth reconnects when it’s back, usually within a few minutes.</p>
          <p v-else class="small" style="color: var(--err)">{{ task.error ?? 'The update failed.' }}</p>
        </div>

        <template v-if="!running">
          <p v-if="info.error" class="callout warn">Couldn’t check for updates: {{ info.error }}</p>
          <div v-else-if="info.available" class="card flat stack available" style="--gap: 10px">
            <div class="row wrap" style="--gap: 10px">
              <span class="badge accent">Update available</span>
              <strong>TrueNAS {{ info.available.version }}</strong>
            </div>
            <a v-if="info.available.releaseNotesUrl" :href="info.available.releaseNotesUrl" target="_blank" rel="noopener" class="small row" style="--gap: 4px">
              What’s new in this version <ExternalLink :size="13" />
            </a>
            <p class="small muted">Installing takes a while and ends with a restart. Apps and shared folders are unavailable for a few minutes.</p>
            <p v-if="info.riskWarning" class="callout warn small">{{ info.riskWarning }}</p>
            <div><button class="btn primary" @click="openConfirm">Update now</button></div>
          </div>
          <p v-else class="row small" style="--gap: 6px"><CircleCheck :size="16" style="color: var(--ok)" /> You’re up to date.</p>
        </template>
      </div>
    </PageState>
  </section>

  <ConfirmDialog
    v-if="confirming && info?.available"
    :key="info.riskWarning ?? 'ok'"
    :title="`Update to TrueNAS ${info.available.version}?`"
    message="Your server downloads and installs the update, then restarts. Apps and shared folders stop for a few minutes and come back on their own."
    action-label="Update and restart"
    :checkbox="info.riskWarning ? 'I understand the risk and want to update anyway.' : undefined"
    :busy="busy"
    :error="startError"
    @confirm="start"
    @close="confirming = false"
  >
    <p v-if="info.riskWarning" class="callout warn">{{ info.riskWarning }}</p>
  </ConfirmDialog>
</template>

<style scoped>
.progress,
.available {
  padding: 14px 16px;
}
.steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  color: var(--text-muted);
}
.steps .running {
  color: var(--text);
  font-weight: 550;
}
.steps .success .mark {
  color: var(--ok);
}
.steps .failed {
  color: var(--err);
}
.mark {
  display: inline-block;
  width: 14px;
}
</style>
