<script setup lang="ts">
/** Radio list for choosing one drive; drives that can't be used are listed with the reason. */
import { computed } from 'vue';
import type { PickerDrive } from './drives.ts';
import DriveRow from './DriveRow.vue';

const props = defineProps<{ drives: PickerDrive[]; name: string; legend: string; emptyText: string }>();
const model = defineModel<string | null>({ required: true });

const sorted = computed(() =>
  [...props.drives].sort((a, b) => Number(Boolean(a.disabledReason)) - Number(Boolean(b.disabledReason)) || a.drive.sizeBytes - b.drive.sizeBytes),
);
const usable = computed(() => props.drives.filter((d) => !d.disabledReason).length);
</script>

<template>
  <fieldset class="choices">
    <legend class="field-label">{{ legend }}</legend>
    <p v-if="!usable" class="callout warn">{{ emptyText }}</p>
    <label v-for="p in sorted" :key="p.drive.identifier" class="choice" :class="{ on: model === p.drive.identifier, off: p.disabledReason }">
      <DriveRow :drive="p.drive" :dim="Boolean(p.disabledReason)">
        <template #leading>
          <input
            type="radio"
            :name="name"
            :value="p.drive.identifier"
            :checked="model === p.drive.identifier"
            :disabled="Boolean(p.disabledReason)"
            :aria-label="`${p.drive.model} (${p.drive.serial})`"
            @change="model = p.drive.identifier"
          />
        </template>
        <template #note>
          <span v-if="p.disabledReason" class="small muted">{{ p.disabledReason }}</span>
          <span v-else-if="p.note" class="small note">{{ p.note }}</span>
        </template>
      </DriveRow>
    </label>
  </fieldset>
</template>

<style scoped>
.choices {
  border: 0;
  margin: 0;
  padding: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.choices legend {
  padding: 0;
  margin-bottom: 8px;
}
.choice {
  display: block;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  cursor: pointer;
}
.choice:hover:not(.off) {
  border-color: var(--accent);
}
.choice.on {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.choice.off {
  cursor: default;
  background: var(--surface-2);
}
.note {
  color: var(--warn);
}
</style>
