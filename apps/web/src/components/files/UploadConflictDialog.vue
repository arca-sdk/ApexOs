<script setup lang="ts">
/** Asks what to do with uploaded names that already exist (TrueNAS itself would overwrite them silently). */
import { computed } from 'vue';
import { File, Folder } from 'lucide-vue-next';
import Modal from '../Modal.vue';
import { uploads, type ConflictDecision } from './uploads.ts';

const prompt = computed(() => uploads.prompt);
const shown = computed(() => prompt.value?.existing.slice(0, 8) ?? []);
const more = computed(() => Math.max(0, (prompt.value?.existing.length ?? 0) - shown.value.length));
const hasFolders = computed(() => prompt.value?.existing.some((e) => e.type === 'folder') ?? false);
const where = computed(() => {
  if (!prompt.value) return '';
  // Folder references may be `pool/Name`; show the name.
  return [prompt.value.folder.split('/').pop(), ...(prompt.value.dir ? prompt.value.dir.split('/') : [])].join(' › ');
});

function decide(decision: ConflictDecision | null) {
  prompt.value?.resolve(decision);
}
</script>

<template>
  <Modal v-if="prompt" :title="prompt.existing.length === 1 ? 'This name is already taken' : 'Some names are already taken'" @close="decide(null)">
    <p>
      {{ prompt.existing.length === 1 ? 'There’s already an item with this name' : `There are already ${prompt.existing.length} items with these names` }} in
      <strong>{{ where }}</strong>:
    </p>
    <ul class="names">
      <li v-for="e in shown" :key="e.name" class="row" style="--gap: 8px">
        <Folder v-if="e.type === 'folder'" :size="16" aria-hidden="true" class="muted" />
        <File v-else :size="16" aria-hidden="true" class="muted" />
        <span class="name">{{ e.name }}</span>
      </li>
      <li v-if="more" class="muted small">and {{ more }} more</li>
    </ul>
    <dl class="choices small">
      <dt>Replace</dt>
      <dd>
        Overwrite the files on the server with yours.
        <template v-if="hasFolders">Folders are combined: your files are added, and files with the same name are replaced.</template>
      </dd>
      <dt>Keep both</dt>
      <dd>Upload yours with a number added, like “photo (1).jpg”.</dd>
      <dt>Skip</dt>
      <dd>Leave what’s on the server and don’t upload these.</dd>
    </dl>
    <template #footer>
      <button class="btn" type="button" @click="decide(null)">Cancel upload</button>
      <button class="btn" type="button" @click="decide('skip')">Skip</button>
      <button class="btn" type="button" @click="decide('keep-both')">Keep both</button>
      <button class="btn danger" type="button" @click="decide('replace')">Replace</button>
    </template>
  </Modal>
</template>

<style scoped>
.names {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 220px;
  overflow: auto;
}
.name {
  overflow-wrap: anywhere;
}
.choices {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 12px;
  margin: 0;
}
.choices dt {
  font-weight: 600;
}
.choices dd {
  margin: 0;
  color: var(--text-muted);
}
</style>
