<script setup lang="ts">
/**
 * New passphrase, typed twice. The inputs ask browsers and password managers not to save or fill them;
 * the value only lives in the parent's state until it is sent.
 */
import PasswordInput from '../users/PasswordInput.vue';
import { MIN_PASSPHRASE } from './encryptionRules.ts';

defineProps<{
  idPrefix: string;
  errors?: { passphrase?: string; again?: string };
  label?: string;
}>();
const passphrase = defineModel<string>('passphrase', { required: true });
const again = defineModel<string>('again', { required: true });
const emit = defineEmits<{ input: [] }>();
</script>

<template>
  <div class="stack" style="--gap: 12px">
    <div class="field">
      <label :for="`${idPrefix}-pass`">{{ label ?? 'Passphrase' }}</label>
      <PasswordInput
        :id="`${idPrefix}-pass`"
        v-model="passphrase"
        autocomplete="new-password"
        :invalid="!!errors?.passphrase"
        :describedby="`${idPrefix}-pass-hint ${idPrefix}-pass-err`"
        @input="emit('input')"
      />
      <span :id="`${idPrefix}-pass-hint`" class="hint">At least {{ MIN_PASSPHRASE }} characters. A short sentence only you would think of is easy to type and hard to guess.</span>
      <span v-if="errors?.passphrase" :id="`${idPrefix}-pass-err`" class="error-text">{{ errors.passphrase }}</span>
    </div>
    <div class="field">
      <label :for="`${idPrefix}-again`">Type it again</label>
      <PasswordInput
        :id="`${idPrefix}-again`"
        v-model="again"
        autocomplete="new-password"
        :invalid="!!errors?.again"
        :describedby="`${idPrefix}-again-err`"
        @input="emit('input')"
      />
      <span v-if="errors?.again" :id="`${idPrefix}-again-err`" class="error-text">{{ errors.again }}</span>
    </div>
  </div>
</template>
