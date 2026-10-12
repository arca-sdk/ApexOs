<script setup lang="ts">
/** Text box for a 6-digit authenticator code, or a recovery code when `recovery` is set. */
const model = defineModel<string>({ required: true });
defineProps<{ id: string; recovery?: boolean; invalid?: boolean; describedby?: string }>();
</script>

<template>
  <input
    :id="id"
    v-model="model"
    class="code-input"
    :class="{ recovery }"
    type="text"
    :inputmode="recovery ? 'text' : 'numeric'"
    :autocomplete="recovery ? 'off' : 'one-time-code'"
    :pattern="recovery ? undefined : '\\s*[0-9]{3}\\s?[0-9]{3}\\s*'"
    :maxlength="recovery ? 16 : 7"
    :placeholder="recovery ? 'xxxxx-xxxxx' : undefined"
    :aria-invalid="invalid || undefined"
    :aria-describedby="describedby"
    autocapitalize="off"
    autocorrect="off"
    spellcheck="false"
    required
  />
</template>
