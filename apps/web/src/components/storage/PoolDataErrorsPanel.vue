<script setup lang="ts">
/**
 * Damaged files on a pool: what is affected (grouped by kind), what the user can do about it, and the
 * Repair (TrueNAS app-catalog files only), Check pool and Reset error count actions.
 */
import { computed, onMounted, ref, watch } from 'vue';
import { CircleCheck, FileWarning, HardDrive, MemoryStick, Plug, RotateCcw, ScanSearch, ShieldAlert, Wrench } from 'lucide-vue-next';
import type { DataErrorEntry, Pool, PoolDataErrors, Task, TaskStarted } from '@apexos/api-types';
import ConfirmDialog from '../ConfirmDialog.vue';
import Modal from '../Modal.vue';
import TaskItem from '../notifications/TaskItem.vue';
import ScanProgress from './ScanProgress.vue';
import { pollRunningTask } from './taskPoll.ts';
import { ApiError, api } from '../../lib/api.ts';
import { live, onServerChange } from '../../lib/events.ts';

const props = defineProps<{ pool: Pool }>();
const emit = defineEmits<{ close: []; drives: [] }>();

const SHOW_FIRST = 50;

const data = ref<PoolDataErrors | null>(null);
const loading = ref(true);
const loadError = ref<string | null>(null);
const actionError = ref<string | null>(null);
const showAllUser = ref(false);

async function load(fresh = false) {
  try {
    data.value = await api.get<PoolDataErrors>(`/storage/pools/${props.pool.id}/errors${fresh ? '?fresh=1' : ''}`);
    loadError.value = null;
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

onMounted(() => load(true));
// The server caches the list and re-reads it when the pool changes (a check finished, counters moved).
onServerChange(['storage'], () => load());
watch(
  () => [props.pool.scan?.state, props.pool.scan?.finishedAt, props.pool.errors.read, props.pool.errors.write, props.pool.errors.checksum].join('|'),
  () => load(),
);

const byKind = (kind: DataErrorEntry['kind']) => computed(() => data.value?.entries.filter((e) => e.kind === kind) ?? []);
const userFiles = byKind('user');
const snapshots = byKind('snapshot');
const catalogFiles = byKind('catalog');
const unreadable = byKind('unreadable');
const visibleUserFiles = computed(() => (showAllUser.value ? userFiles.value : userFiles.value.slice(0, SHOW_FIRST)));
const damagedFiles = computed(() => userFiles.value.length + snapshots.value.length + catalogFiles.value.length);
const tooMany = computed(() => data.value?.repair.code === 'TOO_MANY_FILES');

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// --- Repair ---------------------------------------------------------------

function runningRepair(): Task | undefined {
  return Object.values(live.tasks).find((t) => t.type === 'pool-repair' && t.ref === props.pool.displayName && t.status === 'running');
}
const repairTaskId = ref<string | null>(runningRepair()?.id ?? null);
const startedTask = ref<Task | null>(null);
const repairTask = computed<Task | null>(() => (repairTaskId.value ? (live.tasks[repairTaskId.value] ?? startedTask.value) : null));
const repairing = computed(() => repairTask.value?.status === 'running');
const confirmingRepair = ref(false);
const startingRepair = ref(false);
pollRunningTask(() => repairTaskId.value);

watch(
  () => repairTask.value?.status,
  (status) => {
    if (status && status !== 'running') void load(true);
  },
);

async function repair() {
  const fingerprint = data.value?.fingerprint;
  confirmingRepair.value = false;
  if (!fingerprint) return;
  actionError.value = null;
  startingRepair.value = true;
  try {
    const { task } = await api.post<TaskStarted>(`/storage/pools/${props.pool.id}/repair`, { fingerprint });
    startedTask.value = task;
    repairTaskId.value = task.id;
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e);
    if (e instanceof ApiError && e.code === 'FINGERPRINT_CHANGED') void load(true);
  } finally {
    startingRepair.value = false;
  }
}

const showRepair = computed(() => data.value?.state === 'quick-repair' || repairing.value);
const repairBlocked = computed(() => {
  const r = data.value?.repair;
  if (repairing.value) return 'A repair is running.';
  return r && !r.allowed ? r.reason : null;
});

// --- Check pool -------------------------------------------------------------

const scanRunning = computed(() => props.pool.scan?.state === 'running' || props.pool.scan?.state === 'paused');
const checkBlocked = computed(() => {
  if (props.pool.health === 'offline') return 'The pool is unavailable.';
  if (scanRunning.value) return 'A check or rebuild is already running.';
  if (repairing.value) return 'The repair runs its own check.';
  return null;
});
const startingCheck = ref(false);
async function checkPool() {
  actionError.value = null;
  startingCheck.value = true;
  try {
    await api.post(`/storage/pools/${props.pool.id}/scrub`);
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e);
  } finally {
    startingCheck.value = false;
  }
}

// --- Reset error count ------------------------------------------------------

const errorTotal = computed(() => props.pool.errors.read + props.pool.errors.write + props.pool.errors.checksum);
const confirmingReset = ref(false);
const resetting = ref(false);
const resetError = ref<string | null>(null);
const resetDone = ref(false);
async function resetCounts() {
  resetError.value = null;
  resetting.value = true;
  try {
    await api.post(`/storage/pools/${props.pool.id}/reset-errors`);
    confirmingReset.value = false;
    resetDone.value = true;
    await load();
  } catch (e) {
    resetError.value = e instanceof Error ? e.message : String(e);
  } finally {
    resetting.value = false;
  }
}

const reasonId = computed(() => `reset-reason-${props.pool.id}`);
</script>

<template>
  <Modal :title="`Damaged files on ${pool.displayName}`" wide @close="emit('close')">
    <div v-if="loading && !data" class="row muted" role="status" style="--gap: 10px">
      <span class="spin" aria-hidden="true" /> Reading the list of damaged files from the server…
    </div>
    <div v-else-if="loadError && !data" class="callout err stack" style="--gap: 8px">
      <span>ApexOs couldn’t load the list of damaged files: {{ loadError }}</span>
      <div><button class="btn small" @click="load(true)">Try again</button></div>
    </div>

    <template v-else-if="data">
      <!-- What is going on -->
      <div v-if="data.state === 'quick-repair'" class="callout warn status" role="status">
        <Wrench :size="18" aria-hidden="true" />
        <div class="stack" style="--gap: 4px">
          <strong>Needs a quick repair</strong>
          <span>
            Only TrueNAS’s own copy of the app catalog (the list of apps it can install) is damaged. Your files are fine and your apps keep running.
            Repair deletes the {{ plural(data.catalogFiles, 'damaged file', 'damaged files') }}, checks the whole pool, then downloads a fresh catalog.
          </span>
        </div>
      </div>
      <div v-else-if="data.state === 'user-files'" class="callout err status" role="status">
        <FileWarning :size="18" aria-hidden="true" />
        <div class="stack" style="--gap: 4px">
          <strong>{{ data.label }}</strong>
          <span>Some of your files are damaged and can’t be read. ApexOs never deletes your files; below is what you can do.</span>
        </div>
      </div>
      <div v-else-if="data.state === 'data-errors'" class="callout err status" role="status">
        <ShieldAlert :size="18" aria-hidden="true" />
        <div class="stack" style="--gap: 4px">
          <strong>Data errors</strong>
          <span v-if="data.readError">
            ApexOs couldn’t read the list of damaged files ({{ data.readError }}). That doesn’t mean everything is fine. Try again in a moment; if it
            keeps failing, look at the pool in TrueNAS.
          </span>
          <span v-else-if="tooMany">
            {{ data.catalogFiles }} system files are damaged. That much damage points to a bigger problem with a drive, a cable or the memory, so
            ApexOs won’t repair it automatically. Don’t change anything on this pool yet, and get help from someone experienced.
          </span>
          <span v-else>
            ZFS still remembers damage in files that have since been deleted, or in its own internal data. Run <strong>Check pool</strong>: once a
            check finds no more damage, this warning goes away (sometimes it takes two checks).
          </span>
        </div>
      </div>
      <div v-else class="callout ok status" role="status">
        <CircleCheck :size="18" aria-hidden="true" />
        <div class="stack" style="--gap: 4px">
          <strong>No damaged files</strong>
          <span v-if="errorTotal">
            ZFS doesn’t list any damaged files. The drives did report errors; the pool either fixed them from its extra copy or they didn’t hit a
            file.
          </span>
          <span v-else>ZFS doesn’t list any damaged files on this pool.</span>
        </div>
      </div>
      <div v-if="data.readError" class="row"><button class="btn small" @click="load(true)">Read the list again</button></div>

      <ScanProgress :scan="pool.scan" />

      <!-- Live repair -->
      <div v-if="repairTask" class="card flat task-box" aria-live="polite">
        <TaskItem :task="repairTask" show-steps />
        <p v-if="repairTask.status === 'success'" class="small ok-text">
          Repaired. The check found no more damage and the app catalog was refreshed.<template v-if="errorTotal"> The error counts were left as
          they were; reset them below if you like.</template>
        </p>
      </div>
      <p v-if="actionError" class="callout err small" role="alert">{{ actionError }}</p>

      <!-- The files -->
      <section v-if="userFiles.length" class="stack group" style="--gap: 8px" aria-labelledby="dmg-user">
        <h3 id="dmg-user">Your files <span class="badge err">{{ userFiles.length }}</span></h3>
        <ul class="files">
          <li v-for="e in visibleUserFiles" :key="e.raw" class="mono">{{ e.path ?? e.raw }}</li>
        </ul>
        <button v-if="userFiles.length > SHOW_FIRST && !showAllUser" class="btn ghost small" @click="showAllUser = true">
          Show all {{ userFiles.length }}
        </button>
      </section>

      <section v-if="snapshots.length" class="stack group" style="--gap: 8px" aria-labelledby="dmg-snap">
        <h3 id="dmg-snap">Copies in restore points <span class="badge err">{{ snapshots.length }}</span></h3>
        <p class="small muted">Older copies kept by a restore point (snapshot). They go away when that restore point is deleted.</p>
        <ul class="files">
          <li v-for="e in snapshots" :key="e.raw">
            <span class="badge">Restore point</span> <span class="mono">{{ e.snapshot }}</span>
            <div class="mono small muted">{{ e.path ?? 'A file that no longer has a name' }}</div>
          </li>
        </ul>
      </section>

      <section v-if="catalogFiles.length" class="stack group" style="--gap: 8px" aria-labelledby="dmg-catalog">
        <h3 id="dmg-catalog">TrueNAS app catalog <span class="badge warn">{{ catalogFiles.length }}</span></h3>
        <p class="small muted">
          TrueNAS’s downloaded copy of the app list. It can be downloaded again, so these files are safe to delete.
          <template v-if="data.state === 'user-files'"> Repair becomes available once your own files above are dealt with.</template>
        </p>
        <details>
          <summary class="small">Show {{ plural(catalogFiles.length, 'file', 'files') }}</summary>
          <ul class="files">
            <li v-for="e in catalogFiles" :key="e.raw" class="mono small">{{ e.path }}</li>
          </ul>
        </details>
      </section>

      <section v-if="unreadable.length" class="stack group" style="--gap: 6px" aria-labelledby="dmg-gone">
        <h3 id="dmg-gone">Already deleted or internal <span class="badge">{{ unreadable.length }}</span></h3>
        <p class="small muted">
          ZFS refers to these by number because the files were deleted, or because they are part of its own bookkeeping. A clean
          <strong>Check pool</strong> clears them.
        </p>
      </section>

      <!-- What to do about user files -->
      <section v-if="data.state === 'user-files'" class="stack group" style="--gap: 8px" aria-labelledby="dmg-todo">
        <h3 id="dmg-todo">What you can do</h3>
        <ol class="todo">
          <li>For each damaged file, restore a copy from a backup made <strong>before</strong> the damage, or delete the file. Do this over the network share, from your computer.</li>
          <li v-if="snapshots.length">To get rid of damaged copies in restore points, delete those restore points (in TrueNAS: Datasets → the folder → Snapshots).</li>
          <li>Then run <strong>Check pool</strong>. When it finds no more damage, this warning goes away.</li>
          <li>Use <strong>View drives</strong> to see whether a drive is reporting problems.</li>
        </ol>
        <p v-if="data.singleCopy" class="callout warn small">
          This pool keeps a single copy of your data (no mirror or parity), so there is no healthy copy to repair these files from. Next time,
          consider a mirror: two drives holding the same data let ZFS fix damage like this by itself.
        </p>
      </section>

      <!-- Drives look healthy -->
      <section v-if="damagedFiles && data.drivesLookHealthy" class="card flat stack hint" style="--gap: 10px" aria-labelledby="dmg-hint">
        <h3 id="dmg-hint">Your drives look healthy</h3>
        <p class="small">Every drive reports no read or write errors, so the damage more likely came from the memory (RAM) or a loose cable.</p>
        <div class="row tip" style="--gap: 10px">
          <MemoryStick :size="18" aria-hidden="true" />
          <p class="small">
            <strong>Test the memory.</strong> ApexOs doesn’t have a memory test yet; use a tool such as MemTest86+ from a USB stick and let it
            complete at least one full pass.
          </p>
        </div>
        <div class="row tip" style="--gap: 10px">
          <Plug :size="18" aria-hidden="true" />
          <p class="small">
            <strong>Check the connections.</strong> Shut the server down, firmly reseat both ends of each drive’s data and power cables (or swap in
            spare cables), start it again and run Check pool. If new damage shows up, try different ports.
          </p>
        </div>
      </section>

      <!-- Error counts -->
      <section v-if="errorTotal || resetDone" class="stack group" style="--gap: 8px" aria-labelledby="dmg-counts">
        <h3 id="dmg-counts">Error counts</h3>
        <p v-if="errorTotal" class="small">
          The drives reported {{ plural(pool.errors.read, 'read error', 'read errors') }}, {{ plural(pool.errors.write, 'write error', 'write errors') }}
          and {{ plural(pool.errors.checksum, 'checksum error', 'checksum errors') }}. The counts stay until you reset them, which is possible
          once a check started from ApexOs finds no problems.
        </p>
        <p v-else class="small ok-text" role="status">Error counts reset.</p>
        <div v-if="errorTotal" class="row wrap" style="--gap: 10px">
          <button
            class="btn small"
            :disabled="!data.resetErrors.allowed || resetting"
            :aria-describedby="data.resetErrors.allowed ? undefined : reasonId"
            @click="confirmingReset = true"
          >
            <RotateCcw :size="15" aria-hidden="true" /> Reset error count
          </button>
          <span v-if="!data.resetErrors.allowed" :id="reasonId" class="small muted reason">{{ data.resetErrors.reason }}</span>
        </div>
      </section>
    </template>

    <template #footer>
      <button class="btn" @click="emit('drives')"><HardDrive :size="15" aria-hidden="true" /> View drives</button>
      <button class="btn" :disabled="!!checkBlocked || startingCheck" :title="checkBlocked ?? undefined" @click="checkPool">
        <span v-if="startingCheck" class="spin" aria-hidden="true" /><ScanSearch v-else :size="15" aria-hidden="true" /> Check pool
      </button>
      <button
        v-if="showRepair"
        class="btn primary"
        :disabled="!!repairBlocked || startingRepair"
        :title="repairBlocked ?? undefined"
        @click="confirmingRepair = true"
      >
        <span v-if="startingRepair || repairing" class="spin" aria-hidden="true" /><Wrench v-else :size="15" aria-hidden="true" /> Repair
      </button>
      <button v-else class="btn primary" @click="emit('close')">Done</button>
    </template>
  </Modal>

  <ConfirmDialog
    v-if="confirmingRepair && data"
    :title="`Repair ${pool.displayName}?`"
    :message="`ApexOs deletes ${plural(data.catalogFiles, 'damaged file', 'damaged files')} from TrueNAS’s copy of the app catalog, checks the whole pool, then downloads a fresh catalog. Your own files aren’t touched and your apps keep running. The check can take a while on a large pool.`"
    action-label="Repair"
    @confirm="repair"
    @close="confirmingRepair = false"
  />
  <ConfirmDialog
    v-if="confirmingReset"
    :title="`Reset the error count on ${pool.displayName}?`"
    message="The drives’ read, write and checksum error counts go back to zero. The last check found no problems, so this only clears old history; nothing else changes."
    action-label="Reset error count"
    :busy="resetting"
    :error="resetError"
    @confirm="resetCounts"
    @close="confirmingReset = false"
  />
</template>

<style scoped>
.status {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}
.status > :deep(svg) {
  flex: none;
  margin-top: 2px;
}
.callout.warn.status > :deep(svg) {
  color: var(--warn);
}
.callout.err.status > :deep(svg) {
  color: var(--err);
}
.callout.ok.status > :deep(svg) {
  color: var(--ok);
}
.group h3 {
  display: flex;
  align-items: center;
  gap: 8px;
}
.files {
  list-style: none;
  margin: 0;
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  max-height: 240px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 0.85rem;
}
.files li {
  overflow-wrap: anywhere;
}
details summary {
  cursor: pointer;
  margin-bottom: 6px;
}
.todo {
  margin: 0;
  padding-left: 1.3em;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 0.92rem;
}
.hint {
  padding: 14px 16px;
}
.tip {
  align-items: flex-start;
}
.tip > :deep(svg) {
  flex: none;
  margin-top: 2px;
  color: var(--info);
}
.tip p {
  margin: 0;
}
.task-box {
  padding: 12px 14px;
}
.ok-text {
  color: var(--ok);
}
.reason {
  flex: 1 1 220px;
}
.spin {
  width: 14px;
  height: 14px;
}
</style>
