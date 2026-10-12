<script setup lang="ts">
/**
 * Recovery key: download a file with the keys of every automatic-key folder (TrueNAS's own key-file format,
 * so TrueNAS can unlock folders with it too), see when it was last downloaded and what changed since.
 */
import { computed, onMounted, ref } from 'vue';
import { CircleAlert, CircleCheck, Download, KeyRound } from 'lucide-vue-next';
import type { RecoveryKeyStatus } from '@apexos/api-types';
import PageState from '../PageState.vue';
import { api, session } from '../../lib/api.ts';
import { onServerChange } from '../../lib/events.ts';
import { formatDateTime } from '../folders/encryptionRules.ts';

const status = ref<RecoveryKeyStatus | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);

async function load() {
  error.value = null;
  try {
    status.value = await api.get<RecoveryKeyStatus>('/encryption/recovery');
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}
onMounted(load);
onServerChange(['folders'], load);

const downloading = ref(false);
const downloadError = ref<string | null>(null);
const saved = ref<string | null>(null);

function filenameOf(disposition: string | null): string {
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition ?? '');
  if (star) return decodeURIComponent(star[1]!);
  return /filename="([^"]+)"/i.exec(disposition ?? '')?.[1] ?? 'apexos-recovery.json';
}

async function download() {
  downloading.value = true;
  downloadError.value = null;
  saved.value = null;
  try {
    const res = await fetch('/api/encryption/recovery/file', { method: 'POST', credentials: 'same-origin' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) session.authenticated = false;
      throw new Error(body?.error?.message ?? `Download failed (${res.status})`);
    }
    const name = filenameOf(res.headers.get('content-disposition'));
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    saved.value = name;
    await load();
  } catch (e) {
    downloadError.value = e instanceof Error ? e.message : String(e);
  } finally {
    downloading.value = false;
  }
}

const missingKeys = computed(() => status.value?.keyFolders.filter((f) => !f.keyStored) ?? []);
const changed = computed(() => status.value?.addedSinceDownload ?? 0);
</script>

<template>
  <section class="card stack" aria-labelledby="rk-h">
    <div class="row" style="--gap: 10px">
      <KeyRound :size="20" class="muted" />
      <h2 id="rk-h">Recovery key</h2>
    </div>
    <p class="muted small">
      Folders with an automatic key unlock by themselves because the server keeps their keys on its system drive. If that drive fails, or you
      move your storage drives to a new server, you need the recovery file to open those folders again. Download it after adding or changing
      encrypted folders.
    </p>

    <PageState :loading="loading" :error="error" @retry="load">
      <div v-if="status" class="stack" style="--gap: 14px">
        <p v-if="!status.keyFolders.length" class="callout">
          None of your folders use an automatic key yet, so there’s nothing to put in a recovery file.
          <template v-if="status.passphraseFolders.length"> Folders with a passphrase don’t need one: only you know their passphrase.</template>
        </p>

        <template v-else>
          <p v-if="!status.lastDownloadedAt" class="callout warn" role="status">
            You haven’t downloaded a recovery file yet. Without it, {{ status.keyFolders.length === 1 ? 'your encrypted folder' : `your ${status.keyFolders.length} encrypted folders` }}
            can’t be opened if the server’s system drive fails.
          </p>
          <p v-else-if="changed" class="callout warn" role="status">
            {{ changed === 1 ? '1 encrypted folder was' : `${changed} encrypted folders were` }} added or changed since your last download. Download a new recovery file.
          </p>
          <p v-else class="callout ok" role="status">Your recovery file is up to date.</p>

          <dl class="facts small">
            <dt>Last downloaded</dt>
            <dd>{{ status.lastDownloadedAt ? formatDateTime(status.lastDownloadedAt) : 'Never' }}</dd>
          </dl>

          <ul class="list" aria-label="Folders with an automatic key">
            <li v-for="f in status.keyFolders" :key="f.dataset" class="row" style="--gap: 10px">
              <CircleCheck v-if="f.inFile" :size="16" class="ok-icon" />
              <CircleAlert v-else :size="16" class="warn-icon" />
              <RouterLink :to="{ path: '/folders', query: { folder: f.name } }">{{ f.name }}</RouterLink>
              <span class="small muted">on {{ f.pool }}</span>
              <span class="spacer" />
              <span class="small" :class="f.inFile ? 'muted' : 'warn-text'">{{ f.inFile ? 'In your file' : 'Not in your file yet' }}</span>
            </li>
          </ul>
          <p v-if="missingKeys.length" class="callout err small">
            The server doesn’t have the key of {{ missingKeys.map((f) => f.name).join(', ') }} any more, so {{ missingKeys.length === 1 ? 'it stays' : 'they stay' }} locked
            after a restart. Open the folder and unlock it with a recovery file that contains its key.
          </p>
        </template>

        <p v-if="status.passphraseFolders.length && status.keyFolders.length" class="small muted">
          Not in the file: {{ status.passphraseFolders.join(', ') }} {{ status.passphraseFolders.length === 1 ? 'uses' : 'use' }} a passphrase, which only you know.
        </p>

        <div v-if="status.keyFolders.length" class="stack" style="--gap: 8px">
          <div>
            <button class="btn primary" :disabled="downloading" @click="download">
              <span v-if="downloading" class="spin" /><Download v-else :size="16" /> Download recovery file
            </button>
          </div>
          <p class="small muted">
            Anyone who has this file and your drives can open these folders, so keep it somewhere safe that isn’t this server: a password manager,
            or a USB stick in a drawer. TrueNAS can use it directly (Datasets → Unlock → key file).
          </p>
          <p v-if="saved" class="callout ok small" role="status">Saved {{ saved }}. Store it somewhere safe.</p>
          <p v-if="downloadError" class="callout err small" role="alert">{{ downloadError }}</p>
        </div>
      </div>
    </PageState>
  </section>
</template>

<style scoped>
.facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 14px;
  margin: 0;
}
.facts dt {
  color: var(--text-muted);
}
.facts dd {
  margin: 0;
}
.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.list li {
  flex-wrap: wrap;
}
.ok-icon {
  color: var(--ok);
  flex-shrink: 0;
}
.warn-icon {
  color: var(--warn);
  flex-shrink: 0;
}
.warn-text {
  color: var(--warn);
}
</style>
