<script setup lang="ts">
/** Changes a pool's display name (the name on disk never changes, so paths stay the same). */
import { computed, ref } from 'vue';
import type { Pool } from '@hearth/api-types';
import Modal from '../Modal.vue';
import { ApiError, api } from '../../lib/api.ts';

const props = defineProps<{ pool: Pool }>();
const emit = defineEmits<{ close: []; done: [] }>();

const name = ref(props.pool.displayName);
const busy = ref(false);
const error = ref<string | null>(null);
const fieldError = ref<string | null>(null);

const problem = computed(() => {
  const n = name.value.trim();
  if (!n) return 'Enter a name.';
  if (n.length > 40) return 'Keep it to 40 characters or fewer.';
  return null;
});

async function save() {
  if (problem.value || busy.value) return;
  busy.value = true;
  error.value = fieldError.value = null;
  try {
    await api.patch(`/storage/pools/${props.pool.id}`, { displayName: name.value.trim() });
    emit('done');
  } catch (e) {
    if (e instanceof ApiError) {
      fieldError.value = e.fields.displayName ?? null;
      if (!fieldError.value) error.value = e.message;
    } else error.value = String(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Modal title="Rename pool" @close="emit('close')">
    <form id="rename-pool" class="stack" @submit.prevent="save">
      <div class="field">
        <label for="pool-display-name">Name</label>
        <input id="pool-display-name" v-model="name" type="text" maxlength="40" autocomplete="off" :aria-invalid="Boolean(fieldError || problem)" />
        <span v-if="fieldError || (problem && name !== pool.displayName)" class="error-text">{{ fieldError ?? problem }}</span>
        <span class="hint">
          Only changes how the pool is shown in Hearth. On the server it stays <span class="mono">{{ pool.name }}</span>, so folders and apps keep working.
        </span>
      </div>
      <p v-if="error" class="callout err">{{ error }}</p>
    </form>
    <template #footer>
      <button class="btn" type="button" @click="emit('close')">Cancel</button>
      <button class="btn primary" type="submit" form="rename-pool" :disabled="Boolean(problem) || busy"><span v-if="busy" class="spin" />Save</button>
    </template>
  </Modal>
</template>
