<script setup lang="ts">
/**
 * Confirmation for destructive or risky actions. With `confirmText`, the user must type it;
 * with `checkbox`, they must tick an acknowledgement line.
 */
import { computed, ref } from 'vue';
import Modal from './Modal.vue';

const props = defineProps<{
  title: string;
  message: string;
  actionLabel: string;
  danger?: boolean;
  confirmText?: string;
  checkbox?: string;
  busy?: boolean;
  error?: string | null;
}>();
const emit = defineEmits<{ confirm: []; close: [] }>();
const typed = ref('');
const ticked = ref(false);
const ready = computed(
  () => (!props.confirmText || typed.value.trim() === props.confirmText) && (!props.checkbox || ticked.value) && !props.busy,
);
</script>

<template>
  <Modal :title="title" @close="emit('close')">
    <p>{{ message }}</p>
    <slot />
    <div v-if="confirmText" class="field">
      <label for="confirm-text">Type <strong>{{ confirmText }}</strong> to confirm</label>
      <input id="confirm-text" v-model="typed" type="text" autocomplete="off" />
    </div>
    <label v-if="checkbox" class="row consent" style="--gap: 10px">
      <input v-model="ticked" type="checkbox" />
      <span>{{ checkbox }}</span>
    </label>
    <p v-if="error" class="callout err">{{ error }}</p>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn" :class="danger ? 'danger solid' : 'primary'" :disabled="!ready" @click="emit('confirm')">
        <span v-if="busy" class="spin" />{{ actionLabel }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.consent {
  align-items: flex-start;
}
.consent input {
  margin-top: 3px;
}
</style>
