<script setup lang="ts">
/** The upload queue: one card per batch with byte-weighted progress, cancel and retry. */
import { computed, ref } from 'vue';
import { ChevronDown, ChevronUp, CircleCheck, CircleX, RotateCcw, Upload, X } from 'lucide-vue-next';
import { formatBytes } from '../../lib/format.ts';
import { batchStats, cancelAll, cancelBatch, cancelItem, clearFinished, retryFailed, uploads, uploadSummary, type UploadBatch } from './uploads.ts';

const collapsed = ref(false);
const expanded = ref(new Set<number>());
const batches = computed(() => [...uploads.batches].reverse());

function toggle(batch: UploadBatch) {
  const next = new Set(expanded.value);
  if (next.has(batch.id)) next.delete(batch.id);
  else next.add(batch.id);
  expanded.value = next;
}

function summary(batch: UploadBatch): string {
  const s = batchStats(batch);
  const parts: string[] = [];
  if (s.open) parts.push(`${s.open} left`);
  if (s.done) parts.push(`${s.done} uploaded`);
  if (s.skipped) parts.push(`${s.skipped} skipped`);
  if (s.failed) parts.push(`${s.failed} failed`);
  if (s.canceled) parts.push(`${s.canceled} canceled`);
  return parts.join(' · ');
}

const STATUS_LABEL = { queued: 'Waiting', uploading: 'Uploading', done: 'Uploaded', skipped: 'Skipped', failed: 'Failed', canceled: 'Canceled' } as const;
</script>

<template>
  <section v-if="uploads.batches.length" class="card upload-panel" aria-labelledby="upload-panel-title">
    <header class="row" style="--gap: 8px">
      <Upload :size="16" aria-hidden="true" />
      <h2 id="upload-panel-title" class="title">
        {{ uploadSummary.busy ? `Uploading · ${uploadSummary.percent}%` : 'Uploads finished' }}
      </h2>
      <span class="spacer" />
      <button v-if="uploadSummary.busy" type="button" class="btn ghost small" @click="cancelAll">Cancel all</button>
      <button v-else type="button" class="btn ghost small" @click="clearFinished">Clear</button>
      <button type="button" class="btn ghost small" :aria-expanded="!collapsed" :aria-label="collapsed ? 'Show uploads' : 'Hide uploads'" @click="collapsed = !collapsed">
        <ChevronUp v-if="collapsed" :size="16" /><ChevronDown v-else :size="16" />
      </button>
    </header>
    <div v-if="uploadSummary.busy" class="meter" role="progressbar" :aria-valuenow="uploadSummary.percent" aria-valuemin="0" aria-valuemax="100" aria-label="Upload progress">
      <span :style="{ width: `${uploadSummary.percent}%` }" />
    </div>
    <ul v-if="!collapsed" class="batches">
      <li v-for="batch in batches" :key="batch.id" class="batch stack" style="--gap: 6px">
        <div class="row" style="--gap: 8px">
          <span v-if="batchStats(batch).open" class="spin small-spin" aria-hidden="true" />
          <CircleX v-else-if="batchStats(batch).failed" :size="16" class="err" aria-hidden="true" />
          <CircleCheck v-else :size="16" class="ok" aria-hidden="true" />
          <div class="batch-text">
            <strong class="ellipsis">{{ batch.label }}</strong>
            <span class="small muted ellipsis">to {{ batchStats(batch).destination.split('/').join(' › ') }}</span>
            <span class="small muted">{{ summary(batch) }}</span>
          </div>
          <span class="spacer" />
          <button v-if="batchStats(batch).failed && !batchStats(batch).open" type="button" class="btn ghost small" title="Try the failed files again" aria-label="Retry failed files" @click="retryFailed(batch)">
            <RotateCcw :size="14" />
          </button>
          <button v-if="batchStats(batch).open" type="button" class="btn ghost small" :aria-label="`Cancel uploading ${batch.label}`" @click="cancelBatch(batch)"><X :size="14" /></button>
          <button type="button" class="btn ghost small" :aria-expanded="expanded.has(batch.id)" @click="toggle(batch)">{{ expanded.has(batch.id) ? 'Less' : 'Details' }}</button>
        </div>
        <ul v-if="expanded.has(batch.id)" class="items small">
          <li v-for="item in batch.items.slice(0, 200)" :key="item.id" class="item">
            <span class="ellipsis" :title="item.relName">{{ item.savedAs && item.savedAs !== item.relName.split('/').pop() ? `${item.relName} → ${item.savedAs}` : item.relName }}</span>
            <span class="muted">{{ formatBytes(item.size) }}</span>
            <span :class="{ err: item.status === 'failed' }">
              {{ item.status === 'uploading' ? (item.loaded >= item.size ? 'Saving…' : `${Math.round((item.loaded / Math.max(item.size, 1)) * 100)}%`) : STATUS_LABEL[item.status] }}
            </span>
            <button v-if="item.status === 'queued' || item.status === 'uploading'" type="button" class="btn ghost small" :aria-label="`Cancel ${item.relName}`" @click="cancelItem(item)"><X :size="12" /></button>
            <span v-if="item.error" class="item-error">{{ item.error }}</span>
          </li>
          <li v-if="batch.items.length > 200" class="muted">and {{ batch.items.length - 200 }} more</li>
        </ul>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.upload-panel {
  position: fixed;
  left: 20px;
  bottom: 20px;
  width: min(380px, calc(100vw - 40px));
  max-height: min(60vh, 520px);
  overflow: auto;
  padding: 14px 16px;
  z-index: 49;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.title {
  font-size: 0.95rem;
}
.batches,
.items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.batch-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.ellipsis {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.items {
  gap: 4px;
  padding-left: 24px;
}
.item {
  display: grid;
  grid-template-columns: 1fr auto auto auto;
  gap: 8px;
  align-items: center;
}
.item-error {
  grid-column: 1 / -1;
  color: var(--err);
}
.err {
  color: var(--err);
}
.ok {
  color: var(--ok);
}
.small-spin {
  width: 14px;
  height: 14px;
  color: var(--accent);
}
@media (max-width: 800px) {
  .upload-panel {
    left: 10px;
    bottom: 10px;
    width: calc(100vw - 20px);
  }
}
</style>
