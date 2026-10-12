<script setup lang="ts">
/**
 * Password field with a show/hide toggle. `autocomplete` defaults to `new-password`, and the
 * data-*-ignore hints ask common password managers not to offer saving server/share passwords here.
 */
import { ref } from 'vue';
import { Eye, EyeOff } from 'lucide-vue-next';

withDefaults(
  defineProps<{
    id: string;
    autocomplete?: string;
    placeholder?: string;
    required?: boolean;
    invalid?: boolean;
    describedby?: string;
    /** Ask password managers not to save or fill this field. */
    noSave?: boolean;
  }>(),
  { autocomplete: 'new-password', placeholder: undefined, required: false, invalid: false, describedby: undefined, noSave: true },
);
const model = defineModel<string>({ required: true });
const visible = ref(false);
</script>

<template>
  <div class="pw">
    <input
      :id="id"
      v-model="model"
      :type="visible ? 'text' : 'password'"
      :autocomplete="autocomplete"
      :placeholder="placeholder"
      :required="required"
      :aria-invalid="invalid || undefined"
      :aria-describedby="describedby"
      autocapitalize="off"
      spellcheck="false"
      :data-1p-ignore="noSave || undefined"
      :data-lpignore="noSave ? 'true' : undefined"
      :data-bwignore="noSave || undefined"
      :data-form-type="noSave ? 'other' : undefined"
    />
    <button
      type="button"
      class="btn ghost small toggle"
      :aria-label="visible ? 'Hide password' : 'Show password'"
      :aria-pressed="visible"
      :aria-controls="id"
      @click="visible = !visible"
    >
      <EyeOff v-if="visible" :size="16" />
      <Eye v-else :size="16" />
    </button>
  </div>
</template>

<style scoped>
.pw {
  position: relative;
}
.pw input {
  padding-right: 44px;
}
.toggle {
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
  padding: 4px 8px;
  color: var(--text-muted);
}
</style>
