<script setup lang="ts">
/**
 * Storage: pool cards (capacity, protection, live check/rebuild progress, health), the drives of
 * each pool, unused drives, and every pool action the server supports.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Download, HardDrive, Plus, TriangleAlert } from 'lucide-vue-next';
import type { Drive, NewPoolSpec, Pool, StorageOverview, Task, TaskStarted } from '@apexos/api-types';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import PageState from '../components/PageState.vue';
import AddDriveDialog from '../components/storage/AddDriveDialog.vue';
import AddPoolDialog from '../components/storage/AddPoolDialog.vue';
import AddSpareDialog from '../components/storage/AddSpareDialog.vue';
import DriveRow from '../components/storage/DriveRow.vue';
import ImportPoolDialog from '../components/storage/ImportPoolDialog.vue';
import PoolCard from '../components/storage/PoolCard.vue';
import PoolDrivesPanel from '../components/storage/PoolDrivesPanel.vue';
import RenamePoolDialog from '../components/storage/RenamePoolDialog.vue';
import ReplaceDriveDialog from '../components/storage/ReplaceDriveDialog.vue';
import { poolAtRisk, type PickerDrive } from '../components/storage/drives.ts';
import { useTaskRunner } from '../components/storage/taskRunner.ts';
import { ApiError, api } from '../lib/api.ts';
import { live, onServerChange } from '../lib/events.ts';
import { formatBytes } from '../lib/format.ts';

type Dialog =
  | { kind: 'create' }
  | { kind: 'import' }
  | { kind: 'drives'; poolId: number }
  | { kind: 'replace'; poolId: number; drive: Drive; fromPanel: boolean }
  | { kind: 'addDrive'; poolId: number; fromPanel: boolean }
  | { kind: 'addSpare'; poolId: number; fromPanel: boolean }
  | { kind: 'rename'; poolId: number }
  | { kind: 'delete'; poolId: number };

const overview = ref<StorageOverview | null>(null);
const loading = ref(true);
const loadError = ref<string | null>(null);
const dialog = ref<Dialog | null>(null);
const scrubBusy = ref<Record<number, boolean>>({});
const scrubError = ref<Record<number, string | null>>({});

async function load(quiet = false) {
  if (!quiet) loading.value = !overview.value;
  try {
    overview.value = await api.get<StorageOverview>('/storage');
    loadError.value = null;
  } catch (e) {
    if (!quiet || !overview.value) loadError.value = e instanceof ApiError ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

onMounted(() => load());
onServerChange(['storage'], () => load(true));

// Checks, rebuilds and expansions progress on the server without change events, so poll while one runs.
const anyScanRunning = computed(() => overview.value?.pools.some((p) => p.scan?.state === 'running') ?? false);
let poll: ReturnType<typeof setInterval> | undefined;
watch(
  anyScanRunning,
  (running) => {
    clearInterval(poll);
    if (running) poll = setInterval(() => load(true), 3000);
  },
  { immediate: true },
);
onBeforeUnmount(() => clearInterval(poll));

const pools = computed(() => overview.value?.pools ?? []);
const unassigned = computed(() => overview.value?.unassigned ?? []);
const freeDrives = computed(() => unassigned.value.filter((d) => d.available));
const atRisk = computed(() => poolAtRisk(pools.value));
const dialogPool = computed<Pool | null>(() => {
  const d = dialog.value;
  if (!d || !('poolId' in d)) return null;
  return pools.value.find((p) => p.id === d.poolId) ?? null;
});

// A pool can disappear (deleted elsewhere) while one of its dialogs is open.
watch(dialogPool, (pool) => {
  if (dialog.value && 'poolId' in dialog.value && !pool && overview.value && dialog.value.kind !== 'delete') dialog.value = null;
});

function poolTasks(pool: Pool): Task[] {
  return Object.values(live.tasks).filter((t) => t.status === 'running' && t.type.startsWith('pool-') && t.ref === pool.displayName);
}

function closeSub() {
  const d = dialog.value;
  dialog.value = d && 'fromPanel' in d && d.fromPanel ? { kind: 'drives', poolId: d.poolId } : null;
}

function subDone() {
  closeSub();
  void load(true);
}

async function scrub(pool: Pool) {
  scrubBusy.value = { ...scrubBusy.value, [pool.id]: true };
  scrubError.value = { ...scrubError.value, [pool.id]: null };
  try {
    await api.post(`/storage/pools/${pool.id}/scrub`);
    await load(true);
  } catch (e) {
    scrubError.value = { ...scrubError.value, [pool.id]: e instanceof Error ? e.message : String(e) };
  } finally {
    scrubBusy.value = { ...scrubBusy.value, [pool.id]: false };
  }
}

// Create pool
const createRunner = useTaskRunner(() => {
  dialog.value = null;
  void load(true);
});
const createDrives = computed<PickerDrive[]>(() =>
  unassigned.value.map((d) => ({
    drive: d,
    disabledReason: d.available ? null : (d.unavailableReason ?? 'Can’t be used for a pool.'),
    note: d.exportedPool
      ? `Holds the pool “${d.exportedPool}”. To keep its data, import it instead; using the drive here erases it.`
      : d.warnings.includes('EXISTING_DATA')
        ? 'Has existing data, which will be erased.'
        : null,
  })),
);
function createPool(spec: NewPoolSpec) {
  void createRunner.start(api.post<TaskStarted>('/storage/pools', spec));
}

// Delete pool
const deleteRunner = useTaskRunner(() => {
  dialog.value = null;
  void load(true);
});
function deletePool(pool: Pool) {
  void deleteRunner.start(api.del<TaskStarted>(`/storage/pools/${pool.id}`, { confirmName: pool.displayName }));
}
const deleteMessage = computed(() => {
  const p = dialogPool.value;
  if (!p) return '';
  const drives = p.drives.length + p.spares.length;
  return `Everything on ${p.displayName} is erased for good: its folders, files${p.isAppsPool ? ', app data' : ''} and restore points. Its ${drives} ${drives === 1 ? 'drive becomes' : 'drives become'} free for other uses. This can’t be undone.`;
});

function openCreate() {
  createRunner.error.value = null;
  createRunner.fieldErrors.value = {};
  dialog.value = { kind: 'create' };
}
function openDelete(pool: Pool) {
  deleteRunner.error.value = null;
  dialog.value = { kind: 'delete', poolId: pool.id };
}

const totals = computed(() => {
  const size = pools.value.reduce((s, p) => s + p.sizeBytes, 0);
  const used = pools.value.reduce((s, p) => s + p.usedBytes, 0);
  return { size, used };
});
</script>

<template>
  <div class="page-header">
    <div>
      <h1>Storage</h1>
      <p class="subtitle">
        <template v-if="pools.length">{{ pools.length }} {{ pools.length === 1 ? 'pool' : 'pools' }} · {{ formatBytes(totals.used) }} used of {{ formatBytes(totals.size) }}</template>
        <template v-else>Your pools and drives.</template>
      </p>
    </div>
    <span class="spacer" />
    <div class="row wrap" style="--gap: 8px">
      <button class="btn" @click="dialog = { kind: 'import' }"><Download :size="16" aria-hidden="true" /> Import pool</button>
      <button class="btn primary" :disabled="!overview" @click="openCreate"><Plus :size="16" aria-hidden="true" /> Create pool</button>
    </div>
  </div>

  <PageState :loading="loading" :error="loadError" @retry="load()">
    <div class="stack" style="--gap: 28px">
      <p v-if="atRisk" class="callout warn row risk" style="--gap: 10px">
        <TriangleAlert :size="18" aria-hidden="true" />
        <span>
          <strong>{{ atRisk.displayName }} is {{ atRisk.health }}.</strong>
          Until it is healthy again, avoid restarting the server, updating it or changing other drives. ApexOs asks you to confirm before any of these.
        </span>
      </p>

      <section v-if="pools.length" class="grid pools" aria-label="Pools">
        <PoolCard
          v-for="pool in pools"
          :key="pool.id"
          :pool="pool"
          :tasks="poolTasks(pool)"
          :scrub-busy="scrubBusy[pool.id]"
          :scrub-error="scrubError[pool.id]"
          @drives="dialog = { kind: 'drives', poolId: pool.id }"
          @scrub="scrub(pool)"
          @rename="dialog = { kind: 'rename', poolId: pool.id }"
          @add-drive="dialog = { kind: 'addDrive', poolId: pool.id, fromPanel: false }"
          @add-spare="dialog = { kind: 'addSpare', poolId: pool.id, fromPanel: false }"
          @delete="openDelete(pool)"
        />
      </section>
      <section v-else class="card stack empty" style="--gap: 12px">
        <HardDrive :size="28" aria-hidden="true" class="muted" />
        <h2>No pools yet</h2>
        <p class="muted">A pool combines one or more drives into storage for your folders and apps.</p>
        <div class="row wrap" style="--gap: 8px">
          <button class="btn primary" :disabled="!freeDrives.length" @click="openCreate">Create pool</button>
          <button class="btn" @click="dialog = { kind: 'import' }">Import pool</button>
        </div>
      </section>

      <section class="stack" style="--gap: 12px" aria-labelledby="unused-title">
        <div class="row wrap" style="--gap: 10px">
          <h2 id="unused-title">Unused drives</h2>
          <span class="badge">{{ unassigned.length }}</span>
          <span class="spacer" />
          <button v-if="freeDrives.length" class="btn small" @click="openCreate"><Plus :size="15" aria-hidden="true" /> Create pool from these</button>
        </div>
        <div v-if="!unassigned.length" class="card flat muted small">Every drive is in use. Connect another drive to create a pool or add a spare.</div>
        <ul v-else class="card flat drive-list">
          <li v-for="d in unassigned" :key="d.identifier">
            <DriveRow :drive="d" :dim="!d.available" show-temp>
              <template #note>
                <span v-if="!d.available" class="small muted">{{ d.unavailableReason }}</span>
                <span v-else-if="d.exportedPool" class="small note">Holds the pool “{{ d.exportedPool }}”. Use <strong>Import pool</strong> to bring it back with its data.</span>
              </template>
              <template #trailing>
                <span class="badge" :class="d.available ? 'ok' : ''">{{ d.available ? 'Ready to use' : 'Not usable' }}</span>
              </template>
            </DriveRow>
          </li>
        </ul>
        <p v-if="overview?.bootDrives.length" class="small muted">
          Not shown: {{ overview.bootDrives.length === 1 ? 'the system drive' : `${overview.bootDrives.length} system drives` }}
          ({{ overview.bootDrives.map((d) => `${d.model}, ${formatBytes(d.sizeBytes)}`).join('; ') }}), which TrueNAS runs from.
        </p>
      </section>
    </div>
  </PageState>

  <AddPoolDialog
    v-if="dialog?.kind === 'create'"
    mode="create"
    :drives="createDrives"
    :taken-names="pools.map((p) => p.name)"
    :busy="createRunner.running.value"
    :error="createRunner.fieldErrors.value.name ? null : createRunner.error.value"
    :field-errors="createRunner.fieldErrors.value"
    @save="createPool"
    @close="dialog = null"
  />
  <ImportPoolDialog v-else-if="dialog?.kind === 'import'" @close="dialog = null" @done="subDone" />
  <template v-else-if="dialogPool && dialog">
    <PoolDrivesPanel
      v-if="dialog.kind === 'drives'"
      :pool="dialogPool"
      @close="dialog = null"
      @replace="(drive) => (dialog = { kind: 'replace', poolId: dialogPool!.id, drive, fromPanel: true })"
      @add-drive="dialog = { kind: 'addDrive', poolId: dialogPool.id, fromPanel: true }"
      @add-spare="dialog = { kind: 'addSpare', poolId: dialogPool.id, fromPanel: true }"
    />
    <ReplaceDriveDialog
      v-else-if="dialog.kind === 'replace'"
      :pool="dialogPool"
      :drive="dialog.drive"
      :unassigned="unassigned"
      :pools="pools"
      @close="closeSub"
      @done="subDone"
    />
    <AddDriveDialog v-else-if="dialog.kind === 'addDrive'" :pool="dialogPool" :unassigned="unassigned" @close="closeSub" @done="subDone" />
    <AddSpareDialog v-else-if="dialog.kind === 'addSpare'" :pool="dialogPool" :unassigned="unassigned" @close="closeSub" @done="subDone" />
    <RenamePoolDialog v-else-if="dialog.kind === 'rename'" :pool="dialogPool" @close="dialog = null" @done="subDone" />
    <ConfirmDialog
      v-else-if="dialog.kind === 'delete'"
      :title="`Delete ${dialogPool.displayName}?`"
      :message="deleteMessage"
      action-label="Delete pool"
      danger
      :confirm-text="dialogPool.displayName"
      :busy="deleteRunner.running.value"
      :error="deleteRunner.error.value"
      @confirm="deletePool(dialogPool)"
      @close="dialog = null"
    >
      <p v-if="dialogPool.isAppsPool" class="callout warn">Your apps run from this pool. Remove them first, or they will stop working.</p>
    </ConfirmDialog>
  </template>
</template>

<style scoped>
.pools {
  grid-template-columns: repeat(auto-fill, minmax(min(320px, 100%), 1fr));
}
.risk {
  align-items: flex-start;
}
.risk :deep(svg) {
  flex: none;
  margin-top: 2px;
  color: var(--warn);
}
.empty {
  align-items: flex-start;
}
.drive-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.drive-list li {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}
.drive-list li:last-child {
  border-bottom: 0;
}
.note {
  color: var(--info);
}
</style>
