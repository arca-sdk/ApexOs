<script setup lang="ts">
/** Changes the schedule, how long restore points are kept and the upload speed of one backup. */
import { computed, ref } from 'vue';
import type { Backup, BackupOptions } from '@apexos/api-types';
import Modal from '../Modal.vue';
import { ApiError, api } from '../../lib/api.ts';
import BackupOptionsFields from './BackupOptionsFields.vue';
import { keepText } from './backups.ts';

const props = defineProps<{ backup: Backup; timezone: string }>();
const emit = defineEmits<{ close: []; done: [] }>();

const options = ref<BackupOptions>({ schedule: { ...props.backup.schedule }, keepDays: props.backup.keepDays, speedLimitMbps: props.backup.speedLimitMbps });
const busy = ref(false);
const error = ref<string | null>(null);
const fields = ref<Record<string, string>>({});
const shorter = computed(() => options.value.keepDays < props.backup.keepDays);

async function save() {
  busy.value = true;
  error.value = null;
  fields.value = {};
  try {
    await api.put(`/backups/${props.backup.id}`, options.value);
    emit('done');
  } catch (e) {
    if (e instanceof ApiError) {
      fields.value = e.fields;
      error.value = e.message;
    } else error.value = String(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Modal :title="`Backup of ${backup.folder} to ${backup.destinationName}`" @close="emit('close')">
    <form id="bs-form" class="stack" @submit.prevent="save">
      <BackupOptionsFields v-model="options" :timezone="timezone" :errors="fields" />
      <p v-if="shorter" class="callout warn">
        Restore points older than {{ keepText(options.keepDays) }} will be deleted on both servers, starting with the next backup.
      </p>
      <p v-if="error" class="callout err" role="alert">{{ error }}</p>
    </form>
    <template #footer>
      <button class="btn" type="button" @click="emit('close')">Cancel</button>
      <button class="btn primary" type="submit" form="bs-form" :disabled="busy"><span v-if="busy" class="spin" />Save</button>
    </template>
  </Modal>
</template>
