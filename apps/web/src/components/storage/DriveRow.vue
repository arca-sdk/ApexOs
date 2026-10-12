<script setup lang="ts">
/**
 * Compact one-line description of a drive: kind icon, model, size, serial and warning badges.
 * Slots: `leading` (e.g. a checkbox), `trailing` (actions) and `note` (extra line under the details).
 */
import { computed } from 'vue';
import { HardDrive, MemoryStick, Usb } from 'lucide-vue-next';
import type { Drive } from '@apexos/api-types';
import { DRIVE_KIND_LABELS, formatBytes, formatTemperature } from '../../lib/format.ts';
import { driveTitle } from './drives.ts';

const props = withDefaults(defineProps<{ drive: Drive; dim?: boolean; showWarnings?: boolean; showTemp?: boolean }>(), {
  showWarnings: true,
  showTemp: false,
});

const icon = computed(() => (props.drive.kind === 'USB' ? Usb : props.drive.kind === 'HDD' ? HardDrive : MemoryStick));
const badges = computed(() => {
  const out: { text: string; cls: string; title: string }[] = [];
  if (!props.showWarnings) return out;
  const d = props.drive;
  if (d.warnings.includes('SMR')) {
    out.push({ text: 'SMR', cls: 'warn', title: 'Shingled recording: fine for single use, very slow to rebuild inside a protected pool.' });
  }
  if (d.exportedPool) out.push({ text: `Holds pool “${d.exportedPool}”`, cls: 'info', title: 'This drive belongs to a pool that is not connected right now.' });
  else if (d.warnings.includes('EXISTING_DATA')) out.push({ text: 'Has data', cls: 'info', title: 'This drive has partitions on it. Using it erases them.' });
  if (d.warnings.includes('DUPLICATE_SERIAL')) out.push({ text: 'Duplicate serial', cls: 'warn', title: 'Often caused by USB enclosures that hide the real serial number.' });
  return out;
});
</script>

<template>
  <div class="drive-row" :class="{ dim }">
    <slot name="leading" />
    <component :is="icon" :size="20" class="kind-icon" aria-hidden="true" />
    <div class="details">
      <div class="line">
        <strong class="model">{{ driveTitle(drive) }}</strong>
        <span class="size">{{ formatBytes(drive.sizeBytes) }}</span>
        <span v-for="b in badges" :key="b.text" class="badge" :class="b.cls" :title="b.title">{{ b.text }}</span>
      </div>
      <div class="meta small muted">
        <span>{{ DRIVE_KIND_LABELS[drive.kind] ?? drive.kind }}</span>
        <span class="mono">{{ drive.serial }}</span>
        <span v-if="showTemp && drive.temperatureC !== null">{{ formatTemperature(drive.temperatureC) }}</span>
      </div>
      <slot name="note" />
    </div>
    <slot name="trailing" />
  </div>
</template>

<style scoped>
.drive-row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.drive-row.dim .details,
.drive-row.dim .kind-icon {
  opacity: 0.6;
}
.kind-icon {
  color: var(--text-muted);
  flex: none;
}
.details {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.line {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 10px;
}
.model {
  font-weight: 600;
  overflow-wrap: anywhere;
}
.size {
  font-weight: 600;
  color: var(--text-muted);
}
.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 12px;
}
.meta .mono {
  overflow-wrap: anywhere;
}
</style>
