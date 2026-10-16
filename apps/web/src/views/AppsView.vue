<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Boxes, LayoutGrid, RefreshCw, X } from 'lucide-vue-next';
import type { AppsResponse, InstalledApp } from '@apexos/api-types';
import { api } from '../lib/api.ts';
import { onServerChange } from '../lib/events.ts';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import PageState from '../components/PageState.vue';
import AppsPoolDialog from '../components/apps/AppsPoolDialog.vue';
import EngineBanner from '../components/apps/EngineBanner.vue';
import InstalledAppCard from '../components/apps/InstalledAppCard.vue';
import UninstallDialog from '../components/apps/UninstallDialog.vue';
import { errorText, updateLabel, upgradeAllRunning, useAppActions } from '../components/apps/apps.ts';

const data = ref<AppsResponse | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);

const actions = useAppActions();
const uninstalling = ref<InstalledApp | null>(null);
const updating = ref<InstalledApp | null>(null);
const confirmAll = ref(false);
const choosingPool = ref(false);

const apps = computed(() => data.value?.apps ?? []);
const updatable = computed(() => apps.value.filter((a) => a.upgradeAvailable));
const updatingAll = computed(() => upgradeAllRunning());

async function load(silent = false) {
  if (!silent) loading.value = true;
  try {
    data.value = await api.get<AppsResponse>('/apps');
    error.value = null;
  } catch (e) {
    if (!silent || !data.value) error.value = errorText(e);
  } finally {
    loading.value = false;
  }
}

/** Silent reload that never overlaps itself; change bursts collapse into one follow-up request. */
let refreshing = false;
let refreshAgain = false;
async function refresh() {
  if (refreshing) {
    refreshAgain = true;
    return;
  }
  refreshing = true;
  try {
    await load(true);
  } finally {
    refreshing = false;
    if (refreshAgain) {
      refreshAgain = false;
      void refresh();
    }
  }
}

onMounted(() => load());
onServerChange(['apps'], () => void refresh());

// While something is changing state (an app starting/stopping, or the engine starting), check back regularly.
let poll: ReturnType<typeof setInterval> | undefined;
const settling = computed(
  () =>
    apps.value.some((a) => a.state === 'deploying' || a.state === 'stopping') ||
    (data.value !== null && Boolean(data.value.engine.pool) && data.value.engine.status !== 'RUNNING'),
);
watch(
  settling,
  (on) => {
    clearInterval(poll);
    if (on) poll = setInterval(() => void refresh(), 4000);
  },
  { immediate: true },
);
onBeforeUnmount(() => clearInterval(poll));

async function afterAction(ok: boolean) {
  if (ok) await refresh();
}

function confirmUninstall(removeData: boolean) {
  const app = uninstalling.value;
  uninstalling.value = null;
  if (app) void actions.uninstall(app.name, removeData).then(afterAction);
}

function confirmUpdate() {
  const app = updating.value;
  updating.value = null;
  if (app) void actions.upgrade(app.name).then(afterAction);
}

function startUpdateAll() {
  confirmAll.value = false;
  void actions.upgradeAll().then(afterAction);
}
</script>

<template>
  <div class="page-header">
    <div>
      <h1>Apps</h1>
      <p class="subtitle">Everything installed on your server. Open, update or remove apps here.</p>
    </div>
    <span class="spacer" />
    <div class="row wrap" style="--gap: 8px">
      <button v-if="updatable.length" class="btn" :disabled="updatingAll" @click="confirmAll = true">
        <span v-if="updatingAll" class="spin" /><RefreshCw v-else :size="16" />
        Update all ({{ updatable.length }})
      </button>
      <RouterLink to="/apps/catalog" class="btn primary"><LayoutGrid :size="16" /> Browse apps</RouterLink>
    </div>
  </div>

  <div class="stack" style="--gap: 20px">
    <EngineBanner v-if="data" :engine="data.engine" @choose="choosingPool = true" />

    <div v-if="actions.errors['*']" class="callout err row" role="alert" style="--gap: 8px">
      <span class="spacer">{{ actions.errors['*'] }}</span>
      <button class="btn ghost small" aria-label="Dismiss error" @click="actions.clearError('*')"><X :size="14" /></button>
    </div>

    <PageState :loading="loading && !data" :error="error" @retry="load()">
      <div v-if="apps.length" class="grid" style="--min: 320px">
        <InstalledAppCard
          v-for="app in apps"
          :key="app.name"
          :app="app"
          :error="actions.errors[app.name]"
          @start="actions.start(app.name).then(afterAction)"
          @stop="actions.stop(app.name).then(afterAction)"
          @update="updating = app"
          @uninstall="uninstalling = app"
          @dismiss-error="actions.clearError(app.name)"
        />
      </div>
      <div v-else-if="data?.engine.pool" class="card empty">
        <Boxes :size="36" aria-hidden="true" class="empty-icon" />
        <h2>No apps yet</h2>
        <p class="muted">
          Stream your movies, back up your photos, keep your passwords safe and more. Curated apps are ready in one click, with folders
          and permissions set up for you.
        </p>
        <RouterLink to="/apps/catalog" class="btn primary">Browse the catalog</RouterLink>
      </div>
    </PageState>
  </div>

  <AppsPoolDialog v-if="choosingPool" @close="choosingPool = false" @done="(choosingPool = false), refresh()" />
  <UninstallDialog v-if="uninstalling" :app="uninstalling" @close="uninstalling = null" @confirm="confirmUninstall" />

  <ConfirmDialog
    v-if="updating"
    :title="`Update ${updating.title}?`"
    :message="`${updating.title} will restart to install the update (${updateLabel(updating)}). It will be unavailable for a minute or two.`"
    action-label="Update"
    @close="updating = null"
    @confirm="confirmUpdate"
  />

  <ConfirmDialog
    v-if="confirmAll"
    title="Update all apps?"
    :message="`${updatable.length === 1 ? 'This app' : `These ${updatable.length} apps`} will be updated one after another. Each one restarts while it updates.`"
    :action-label="`Update ${updatable.length === 1 ? '1 app' : `${updatable.length} apps`}`"
    @close="confirmAll = false"
    @confirm="startUpdateAll"
  >
    <ul class="update-list small">
      <li v-for="a in updatable" :key="a.name">
        <strong>{{ a.title }}</strong> <span class="mono muted">{{ updateLabel(a) }}</span>
      </li>
    </ul>
  </ConfirmDialog>
</template>

<style scoped>
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 10px;
  padding: 40px 24px;
}
.empty p {
  max-width: 480px;
}
.empty-icon {
  color: var(--accent);
}
.update-list {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
</style>
