<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ArrowRight, Boxes, HardDrive, RefreshCw, X } from 'lucide-vue-next';
import type { DashboardResponse } from '@apexos/api-types';
import { api, session } from '../lib/api.ts';
import { onServerChange } from '../lib/events.ts';
import { formatDuration } from '../lib/format.ts';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import PageState from '../components/PageState.vue';
import { errorText, updateLabel, upgradeAllRunning, useAppActions } from '../components/apps/apps.ts';
import ActivityCard from '../components/dashboard/ActivityCard.vue';
import DashboardAppCard from '../components/dashboard/DashboardAppCard.vue';
import MemoryCard from '../components/dashboard/MemoryCard.vue';
import NetworkCard from '../components/dashboard/NetworkCard.vue';
import PoolCard from '../components/dashboard/PoolCard.vue';
import ProcessorCard from '../components/dashboard/ProcessorCard.vue';
import UpdateBanner from '../components/dashboard/UpdateBanner.vue';
import WelcomeBanner from '../components/dashboard/WelcomeBanner.vue';

const data = ref<DashboardResponse | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);

const actions = useAppActions();
const confirmAll = ref(false);

async function load(silent = false) {
  if (!silent) loading.value = true;
  try {
    data.value = await api.get<DashboardResponse>('/dashboard');
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
onServerChange(['storage', 'apps', 'alerts', 'system'], () => void refresh());

const title = computed(() => session.serverName || data.value?.system.hostname || 'Your server');
const updatable = computed(() => data.value?.apps.filter((a) => a.upgradeAvailable) ?? []);
const updatingAll = computed(() => upgradeAllRunning());

function startUpdateAll() {
  confirmAll.value = false;
  void actions.upgradeAll().then((ok) => {
    if (ok) void refresh();
  });
}
</script>

<template>
  <div class="stack" style="--gap: 28px">
    <WelcomeBanner />

    <div class="page-header head">
      <div>
        <h1>{{ title }}</h1>
        <p v-if="data" class="subtitle">
          TrueNAS {{ data.system.version }} · up {{ formatDuration(data.system.uptimeSeconds) }}<template v-if="data.system.lanIp">
            · <span class="mono">{{ data.system.lanIp }}</span></template
          >
        </p>
      </div>
    </div>

    <PageState :loading="loading && !data" :error="error" @retry="load()">
      <template v-if="data">
        <UpdateBanner v-if="data.update" :update="data.update" />

        <section class="stack section" style="--gap: 14px" aria-labelledby="sec-system">
          <h2 id="sec-system">System</h2>
          <div class="grid system-grid">
            <ProcessorCard :system="data.system" />
            <MemoryCard :system="data.system" />
            <NetworkCard />
            <ActivityCard />
          </div>
        </section>

        <section class="stack section" style="--gap: 14px" aria-labelledby="sec-storage">
          <div class="row section-head">
            <h2 id="sec-storage">Storage</h2>
            <span class="spacer" />
            <RouterLink to="/storage" class="small more">Manage storage <ArrowRight :size="14" /></RouterLink>
          </div>
          <div v-if="data.pools.length" class="grid" style="--min: 280px">
            <PoolCard v-for="p in data.pools" :key="p.id" :pool="p" />
          </div>
          <div v-else class="card empty">
            <HardDrive :size="26" aria-hidden="true" class="empty-icon" />
            <div>
              <strong>No storage pools yet</strong>
              <p class="small muted">Group your drives into a pool to start storing files and running apps.</p>
            </div>
            <RouterLink to="/storage" class="btn small">Set up storage</RouterLink>
          </div>
        </section>

        <section class="stack section" style="--gap: 14px" aria-labelledby="sec-apps">
          <div class="row wrap section-head">
            <h2 id="sec-apps">Apps</h2>
            <span class="spacer" />
            <button v-if="updatable.length" class="btn small" :disabled="updatingAll" @click="confirmAll = true">
              <span v-if="updatingAll" class="spin tiny" /><RefreshCw v-else :size="14" />
              Update all ({{ updatable.length }})
            </button>
            <RouterLink to="/apps" class="small more">All apps <ArrowRight :size="14" /></RouterLink>
          </div>
          <div v-if="actions.errors['*']" class="callout err row" role="alert" style="--gap: 8px">
            <span class="spacer">{{ actions.errors['*'] }}</span>
            <button class="btn ghost small" aria-label="Dismiss error" @click="actions.clearError('*')"><X :size="14" /></button>
          </div>
          <div v-if="data.apps.length" class="grid" style="--min: 220px">
            <DashboardAppCard v-for="a in data.apps" :key="a.name" :app="a" />
          </div>
          <div v-else class="card empty">
            <Boxes :size="26" aria-hidden="true" class="empty-icon" />
            <div>
              <strong>No apps yet</strong>
              <p class="small muted">Media servers, photo backup, password managers and more, ready in one click.</p>
            </div>
            <RouterLink to="/apps/catalog" class="btn small primary">Browse apps</RouterLink>
          </div>
        </section>
      </template>
    </PageState>
  </div>

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
.head {
  margin-bottom: 0;
}
.section h2 {
  font-size: 1.05rem;
}
.section-head {
  --gap: 10px;
}
.system-grid {
  grid-template-columns: minmax(0, 1fr);
  align-items: stretch;
}
@media (min-width: 640px) {
  .system-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (min-width: 1440px) {
  .system-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}
.more {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-weight: 600;
}
.empty {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 14px;
}
.empty > div {
  flex: 1;
  min-width: 200px;
}
.empty-icon {
  color: var(--accent);
  flex: none;
}
.tiny {
  width: 12px;
  height: 12px;
}
.update-list {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
</style>
