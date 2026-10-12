<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { FolderPlus, Network, ServerCog } from 'lucide-vue-next';
import type { Backup, BackupDestination, BackupsResponse, Folder, FoldersResponse, TaskStarted } from '@apexos/api-types';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import PageState from '../components/PageState.vue';
import AddDestinationDialog from '../components/backups/AddDestinationDialog.vue';
import BackupRow from '../components/backups/BackupRow.vue';
import BackupSettingsDialog from '../components/backups/BackupSettingsDialog.vue';
import ChangeSpaceDialog from '../components/backups/ChangeSpaceDialog.vue';
import DestinationCard from '../components/backups/DestinationCard.vue';
import NewBackupDialog from '../components/backups/NewBackupDialog.vue';
import RestoreDialog from '../components/backups/RestoreDialog.vue';
import { ago, NETWORK_NOTE } from '../components/backups/backups.ts';
import { ApiError, api, runTask } from '../lib/api.ts';
import { live, onServerChange } from '../lib/events.ts';
import { formatBytes } from '../lib/format.ts';

const route = useRoute();
const router = useRouter();

const data = ref<BackupsResponse | null>(null);
const folders = ref<Folder[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const notice = ref<{ text: string; kind: 'ok' | 'err' } | null>(null);

async function load(fresh = false) {
  try {
    const [b, f] = await Promise.all([api.get<BackupsResponse>(`/backups${fresh ? '?fresh=1' : ''}`), api.get<FoldersResponse>('/folders').catch(() => ({ folders: folders.value }))]);
    data.value = b;
    folders.value = f.folders;
    error.value = null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}
function retry() {
  loading.value = true;
  void load(true);
}
onMounted(() => load());
onServerChange(['backups', 'folders'], () => load());

/** Backup tasks running right now, by backup id (for buttons and the live state). */
const busy = computed(() => {
  const ids = new Set<string>();
  for (const t of Object.values(live.tasks)) if (t.status === 'running' && t.type.startsWith('backup-') && t.ref) ids.add(t.ref);
  return ids;
});
// Refresh when one of our tasks finishes.
watch(
  () => Object.values(live.tasks).filter((t) => t.type.startsWith('backup-') && t.status !== 'running').length,
  () => void load(),
);

const destinationOf = (b: Backup) => data.value?.destinations.find((d) => d.id === b.destinationId);
const problems = computed(() => data.value?.backups.filter((b) => ['failed', 'overdue', 'needs-fresh-copy'].includes(b.status.state)).length ?? 0);
const backedUpFolders = computed(() => new Set(data.value?.backups.map((b) => b.dataset) ?? []));
const notBackedUp = computed(() => folders.value.filter((f) => !backedUpFolders.value.has(f.dataset)));

function say(text: string, kind: 'ok' | 'err' = 'ok') {
  notice.value = { text, kind };
}

// ---- dialogs ----
const addingDestination = ref(false);
const newBackup = ref<{ folder: string | null; destinationId: string | null } | null>(null);
const pendingFolder = ref<string | null>(null);
const settingsFor = ref<Backup | null>(null);
const restoreFor = ref<Backup | null>(null);
const spaceFor = ref<BackupDestination | null>(null);

/** /backups?backup=<Folder> (from a folder's panel) starts backing up that folder. */
watch(
  () => [route.query.backup, data.value !== null] as const,
  ([folder, ready]) => {
    if (typeof folder !== 'string' || !ready || !data.value) return;
    router.replace({ path: '/backups' });
    if (data.value.destinations.length) newBackup.value = { folder, destinationId: null };
    else {
      pendingFolder.value = folder;
      addingDestination.value = true;
    }
  },
  { immediate: true },
);

async function destinationAdded() {
  addingDestination.value = false;
  await load(true);
  say('The destination is ready. Pick the folders to back up there.');
  newBackup.value = { folder: pendingFolder.value, destinationId: data.value?.destinations.at(-1)?.id ?? null };
  pendingFolder.value = null;
}
async function backupsCreated() {
  newBackup.value = null;
  say('Backups are set up. The first copy of each folder has started; it can take a while.');
  await load(true);
}
async function restored(name: string) {
  restoreFor.value = null;
  say(`Restored into the new folder ${name}.`);
  await load();
}

// ---- actions ----
async function act(fn: () => Promise<unknown>, done?: string) {
  notice.value = null;
  try {
    await fn();
    if (done) say(done);
  } catch (e) {
    say(e instanceof Error ? e.message : String(e), 'err');
  }
  await load();
}
const runNow = (b: Backup) => act(() => runTask(api.post<TaskStarted>(`/backups/${b.id}/run`)), `${b.folder} was backed up to ${b.destinationName}.`);
const setPaused = (b: Backup, paused: boolean) =>
  act(() => api.put(`/backups/${b.id}`, { paused }), paused ? `Backups of ${b.folder} to ${b.destinationName} are paused.` : `Backups of ${b.folder} to ${b.destinationName} resumed.`);
const forget = (id: string) => act(() => api.del(`/backups/cleanups/${id}`));

// Confirmations
type Confirmation = { kind: 'backup'; backup: Backup } | { kind: 'fresh'; backup: Backup } | { kind: 'destination'; destination: BackupDestination };
const confirm = ref<Confirmation | null>(null);
const confirmBusy = ref(false);
const confirmError = ref<string | null>(null);
function ask(c: Confirmation) {
  confirmError.value = null;
  confirm.value = c;
}
const confirmText = computed(() => {
  const c = confirm.value;
  if (!c) return null;
  if (c.kind === 'backup') {
    const b = c.backup;
    return {
      title: `Remove the backup of ${b.folder}?`,
      message: `ApexOs stops backing up ${b.folder} to ${b.destinationName} and deletes the copy there${b.restorePoints ? `, with its ${b.restorePoints} restore ${b.restorePoints === 1 ? 'point' : 'points'}` : ''}. The folder on this server isn’t touched. If ${b.destinationName} is off, the copy is deleted when it’s back.`,
      action: 'Remove backup',
      checkbox: `I understand the copy on ${b.destinationName} will be deleted and can’t be restored any more.`,
    };
  }
  if (c.kind === 'fresh') {
    const b = c.backup;
    return {
      title: `Start a fresh copy of ${b.folder}?`,
      message: `The copy on ${b.destinationName} can’t be continued. ApexOs deletes it with all its restore points, then copies the whole folder again. Until that finishes there’s no copy on ${b.destinationName}.`,
      action: 'Start a fresh copy',
      checkbox: 'I understand the old restore points will be deleted.',
    };
  }
  const d = c.destination;
  return {
    title: `Remove ${d.name} as a backup destination?`,
    message: `ApexOs stops all ${d.backupCount === 1 ? '1 backup' : `${d.backupCount} backups`} to ${d.name} and removes what it set up there: the copies with all their restore points, the backup account and the ${formatBytes(d.grantedBytes)} set aside. ${d.health === 'unreachable' ? `${d.name} can’t be reached now, so its side is cleaned up when it’s back.` : ''}`,
    action: 'Remove destination',
    checkbox: `I understand every copy on ${d.name} will be deleted.`,
  };
});
async function confirmed() {
  const c = confirm.value;
  if (!c) return;
  confirmBusy.value = true;
  confirmError.value = null;
  try {
    if (c.kind === 'backup') {
      const t = await runTask(api.del<TaskStarted>(`/backups/${c.backup.id}`));
      say(t.steps.at(-1)?.message ?? `The backup of ${c.backup.folder} was removed.`);
    } else if (c.kind === 'fresh') {
      const started = api.post<TaskStarted>(`/backups/${c.backup.id}/fresh-copy`);
      await started;
      say(`A fresh copy of ${c.backup.folder} is being made.`);
    } else {
      const t = await runTask(api.del<TaskStarted>(`/backups/destinations/${c.destination.id}`));
      const offline = t.steps.find((s) => /offline/.test(s.message ?? ''));
      say(offline?.message ?? `${c.destination.name} is no longer a backup destination.`);
    }
    confirm.value = null;
  } catch (e) {
    confirmError.value = e instanceof ApiError || e instanceof Error ? e.message : String(e);
  } finally {
    confirmBusy.value = false;
  }
  await load(true);
}
</script>

<template>
  <div class="page-header">
    <div>
      <h1>Backups</h1>
      <p class="subtitle">Keep copies of your folders on another server you own, so a broken server or a mistake doesn’t cost you your files.</p>
    </div>
    <span class="spacer" />
    <div class="row wrap" style="--gap: 8px">
      <button class="btn" :disabled="!data" @click="addingDestination = true"><ServerCog :size="18" /> Add destination</button>
      <button class="btn primary" :disabled="!data?.destinations.length" @click="newBackup = { folder: null, destinationId: null }"><FolderPlus :size="18" /> Back up folders</button>
    </div>
  </div>

  <PageState :loading="loading" :error="error" @retry="retry">
    <div v-if="data" class="stack" style="--gap: 28px">
      <p v-if="notice" class="callout row" :class="notice.kind === 'ok' ? 'ok' : 'err'" role="status" style="--gap: 8px">
        <span style="flex: 1">{{ notice.text }}</span>
        <button class="btn ghost small" @click="notice = null">Dismiss</button>
      </p>
      <p v-if="problems" class="callout warn" role="status">
        {{ problems === 1 ? '1 backup needs' : `${problems} backups need` }} attention. Details are below.
      </p>

      <section class="stack" aria-labelledby="dest-h">
        <div class="stack" style="--gap: 4px">
          <h2 id="dest-h">Destinations</h2>
          <p class="small muted">Other TrueNAS servers you own that keep copies of this server’s folders.</p>
        </div>
        <div v-if="data.destinations.length" class="grid" style="--min: 280px">
          <DestinationCard v-for="d in data.destinations" :key="d.id" :destination="d" @space="spaceFor = d" @remove="ask({ kind: 'destination', destination: d })" />
        </div>
        <div v-else class="card stack empty" style="--gap: 12px">
          <strong>No destinations yet</strong>
          <p class="small muted">
            A destination is another TrueNAS SCALE server of yours, for example an older box at home or a server at a relative’s place that you reach through
            your own VPN. ApexOs sets it up for you: you only need its address and admin password.
          </p>
          <div><button class="btn primary" @click="addingDestination = true"><ServerCog :size="18" /> Add destination</button></div>
        </div>
        <p class="small muted row network" style="--gap: 8px"><Network :size="16" aria-hidden="true" /><span>{{ NETWORK_NOTE }}</span></p>
      </section>

      <section class="stack" aria-labelledby="bk-h">
        <div class="stack" style="--gap: 4px">
          <h2 id="bk-h">Folders being backed up</h2>
          <p class="small muted">Times are in the server’s time zone ({{ data.timezone }}). Backups keep running on schedule even when ApexOs isn’t open.</p>
        </div>
        <div v-if="data.backups.length" class="card list">
          <BackupRow
            v-for="b in data.backups"
            :key="b.id"
            :backup="b"
            :destination="destinationOf(b)"
            :timezone="data.timezone"
            :busy="busy.has(b.id)"
            @run="runNow(b)"
            @restore="restoreFor = b"
            @settings="settingsFor = b"
            @pause="setPaused(b, true)"
            @resume="setPaused(b, false)"
            @fresh-copy="ask({ kind: 'fresh', backup: b })"
            @remove="ask({ kind: 'backup', backup: b })"
          />
        </div>
        <div v-else class="card stack empty" style="--gap: 10px">
          <strong>No folders are backed up yet</strong>
          <p class="small muted">{{ data.destinations.length ? 'Pick which folders to copy and when.' : 'Add a destination first, then pick which folders to copy there.' }}</p>
          <div v-if="data.destinations.length">
            <button class="btn primary" @click="newBackup = { folder: null, destinationId: null }"><FolderPlus :size="18" /> Back up folders</button>
          </div>
        </div>
        <p v-if="data.backups.length && notBackedUp.length" class="small muted">
          Not backed up: {{ notBackedUp.map((f) => f.name).join(', ') }}.
        </p>
      </section>

      <section v-if="data.pendingCleanups.length" class="stack" aria-labelledby="cl-h">
        <div class="stack" style="--gap: 4px">
          <h2 id="cl-h">Waiting to clean up</h2>
          <p class="small muted">These servers were off when backups were removed. ApexOs finishes the job when they’re back.</p>
        </div>
        <ul class="card list cleanups">
          <li v-for="c in data.pendingCleanups" :key="c.id" class="row wrap" style="--gap: 10px">
            <div class="stack grow" style="--gap: 2px">
              <strong>{{ c.destinationName }}</strong>
              <span class="small muted">{{ c.description }} · waiting since {{ ago(c.since) }}</span>
            </div>
            <button class="btn small ghost" title="Use this if the server is gone for good" @click="forget(c.id)">Forget</button>
          </li>
        </ul>
      </section>
    </div>
  </PageState>

  <AddDestinationDialog v-if="addingDestination" @close="addingDestination = false" @done="destinationAdded" />
  <NewBackupDialog
    v-if="newBackup && data"
    :destinations="data.destinations"
    :backups="data.backups"
    :folders="folders"
    :timezone="data.timezone"
    :folder="newBackup.folder"
    :destination-id="newBackup.destinationId"
    @close="newBackup = null"
    @done="backupsCreated"
  />
  <BackupSettingsDialog
    v-if="settingsFor && data"
    :backup="settingsFor"
    :timezone="data.timezone"
    @close="settingsFor = null"
    @done="
      settingsFor = null;
      load();
    "
  />
  <RestoreDialog v-if="restoreFor && data" :backup="restoreFor" :timezone="data.timezone" :existing-names="folders.map((f) => f.name)" @close="restoreFor = null" @done="restored" />
  <ChangeSpaceDialog
    v-if="spaceFor"
    :destination="spaceFor"
    @close="spaceFor = null"
    @done="
      spaceFor = null;
      load(true);
    "
  />
  <ConfirmDialog
    v-if="confirm && confirmText"
    :title="confirmText.title"
    :message="confirmText.message"
    :action-label="confirmText.action"
    :checkbox="confirmText.checkbox"
    danger
    :busy="confirmBusy"
    :error="confirmError"
    @confirm="confirmed"
    @close="confirm = null"
  />
</template>

<style scoped>
.empty {
  align-items: flex-start;
}
.list {
  padding: 0;
  overflow: hidden;
}
.list > * + * {
  border-top: 1px solid var(--border);
}
.cleanups {
  list-style: none;
  margin: 0;
}
.cleanups li {
  padding: 14px 18px;
}
.grow {
  flex: 1;
  min-width: 0;
}
.network {
  align-items: flex-start;
}
.network svg {
  flex-shrink: 0;
  margin-top: 2px;
}
</style>
