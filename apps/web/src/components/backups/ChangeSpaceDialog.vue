<script setup lang="ts">
/** Changes how much space is set aside on a destination (its quota and reservation). */
import { computed, ref } from 'vue';
import type { BackupDestination } from '@apexos/api-types';
import Modal from '../Modal.vue';
import { ApiError, api } from '../../lib/api.ts';
import { formatBytes } from '../../lib/format.ts';
import { sizeToBytes, splitSize } from './backups.ts';

const props = defineProps<{ destination: BackupDestination }>();
const emit = defineEmits<{ close: []; done: [] }>();

const initial = splitSize(props.destination.grantedBytes);
const value = ref(initial.value);
const unit = ref<'GB' | 'TB'>(initial.unit);
const busy = ref(false);
const error = ref<string | null>(null);
const bytes = computed(() => sizeToBytes(Number(value.value) || 0, unit.value));
const problem = computed(() => {
  if (bytes.value < 1e9) return 'Set aside at least 1 GB.';
  if (props.destination.usedBytes !== null && bytes.value < props.destination.usedBytes) return `The copies already use ${formatBytes(props.destination.usedBytes)}.`;
  return null;
});

async function save() {
  if (problem.value) return;
  busy.value = true;
  error.value = null;
  try {
    await api.put(`/backups/destinations/${props.destination.id}`, { spaceBytes: bytes.value });
    emit('done');
  } catch (e) {
    error.value = e instanceof ApiError ? (e.fields.spaceBytes ? `${e.message}` : e.message) : String(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Modal :title="`Space on ${destination.name}`" @close="emit('close')">
    <form id="cs-form" class="stack" @submit.prevent="save">
      <p>
        The copies of this server’s folders may use this much space on {{ destination.name }}. It’s reserved there, so nothing else can take it.
        <template v-if="destination.usedBytes !== null"> They use {{ formatBytes(destination.usedBytes) }} now.</template>
      </p>
      <div class="field">
        <label for="cs-value">Space to set aside</label>
        <div class="row" style="--gap: 8px">
          <input id="cs-value" v-model.number="value" type="number" min="1" step="1" class="value" :aria-invalid="!!problem || undefined" />
          <select v-model="unit" class="unit" aria-label="Unit">
            <option value="GB">GB</option>
            <option value="TB">TB</option>
          </select>
        </div>
        <span v-if="problem" class="error-text">{{ problem }}</span>
      </div>
      <p v-if="error" class="callout err" role="alert">{{ error }}</p>
    </form>
    <template #footer>
      <button class="btn" type="button" @click="emit('close')">Cancel</button>
      <button class="btn primary" type="submit" form="cs-form" :disabled="!!problem || busy"><span v-if="busy" class="spin" />Save</button>
    </template>
  </Modal>
</template>

<style scoped>
.value {
  max-width: 140px;
}
.unit {
  width: auto;
}
</style>
