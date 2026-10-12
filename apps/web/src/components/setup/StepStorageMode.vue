<script setup lang="ts">
/** Step 4: how to use the free drives (Recommended, Custom, or only the kept pools). */
import { computed } from 'vue';
import { Archive, SlidersHorizontal, Sparkles } from 'lucide-vue-next';
import ChoiceCard from './ChoiceCard.vue';
import DriveRow from '../storage/DriveRow.vue';
import { formatBytes } from '../../lib/format.ts';
import { useWizard, type StorageMode } from './wizard.ts';

const wizard = useWizard();
const { state } = wizard;

const mode = computed<StorageMode | null>({
  get: () => state.mode,
  set: (m) => m && wizard.setMode(m),
});
const free = computed(() => wizard.candidates.value);
const total = computed(() => free.value.reduce((s, d) => s + d.sizeBytes, 0));
const noDrives = 'There are no free drives to build a pool from.';
const keptList = computed(() => [...wizard.keptPools.value.map((p) => p.displayName), ...wizard.importNames.value].join(', '));
</script>

<template>
  <div class="stack" style="--gap: 16px">
    <div class="stack" role="radiogroup" aria-label="How to set up storage" style="--gap: 10px">
      <ChoiceCard
        v-model="mode"
        name="storage-mode"
        value="recommended"
        :icon="Sparkles"
        title="Recommended"
        badge="Easiest"
        description="Hearth groups your drives by kind and size and picks a layout for each group. You can still adjust the result."
        :disabled="!free.length"
        :disabled-reason="noDrives"
      />
      <ChoiceCard
        v-model="mode"
        name="storage-mode"
        value="custom"
        :icon="SlidersHorizontal"
        title="Custom"
        description="Build each pool yourself: choose the drives and the layout."
        :disabled="!free.length"
        :disabled-reason="noDrives"
      />
      <ChoiceCard
        v-if="wizard.somethingKept.value"
        v-model="mode"
        name="storage-mode"
        value="none"
        :icon="Archive"
        title="Only use the pools I’m keeping"
        :description="`Create nothing new and erase nothing. You’ll use ${keptList}.`"
      />
    </div>

    <p v-if="!free.length && !wizard.somethingKept.value" class="callout err">
      There are no free drives and you aren’t keeping any pool, so there’s nowhere to store anything. Connect a drive, or go back and keep a pool.
    </p>

    <details v-if="free.length" class="card flat free">
      <summary>
        <strong>{{ free.length }} {{ free.length === 1 ? 'drive' : 'drives' }} available</strong>
        <span class="muted small"> · {{ formatBytes(total) }} in total</span>
      </summary>
      <ul class="drives">
        <li v-for="d in free" :key="d.identifier">
          <DriveRow :drive="d">
            <template #note>
              <span v-if="wizard.driveNote(d)" class="small note">{{ wizard.driveNote(d) }}</span>
            </template>
          </DriveRow>
        </li>
      </ul>
    </details>
  </div>
</template>

<style scoped>
.free summary {
  cursor: pointer;
}
.drives {
  list-style: none;
  margin: 12px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.drives li {
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.note {
  color: var(--warn);
}
</style>
