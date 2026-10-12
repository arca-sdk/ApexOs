<script setup lang="ts">
/** A read-only value (address, key) with a Copy button. */
import { ref, useId } from 'vue';
import { Check, Copy } from 'lucide-vue-next';
import { copyText } from '../folders/folderRules.ts';

const props = defineProps<{ value: string; label: string; secret?: boolean }>();
const id = `copy-${useId()}`;
const copied = ref(false);
const failed = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;

async function copy() {
  const ok = await copyText(props.value);
  copied.value = ok;
  failed.value = !ok;
  clearTimeout(timer);
  timer = setTimeout(() => (copied.value = failed.value = false), 2500);
}
</script>

<template>
  <div class="stack" style="--gap: 6px">
    <label :for="id" class="field-label">{{ label }}</label>
    <div class="row copy-row" style="--gap: 8px">
      <input :id="id" class="mono" type="text" readonly :value="value" :autocomplete="secret ? 'off' : undefined" @focus="($event.target as HTMLInputElement).select()" />
      <button type="button" class="btn small" :aria-label="`Copy: ${label}`" @click="copy">
        <Check v-if="copied" :size="16" aria-hidden="true" />
        <Copy v-else :size="16" aria-hidden="true" />
        {{ copied ? 'Copied' : 'Copy' }}
      </button>
    </div>
    <p class="sr-only" aria-live="polite">{{ copied ? 'Copied' : '' }}</p>
    <p v-if="failed" class="small" style="color: var(--err)">Your browser blocked copying. Select the text and copy it yourself.</p>
  </div>
</template>

<style scoped>
.copy-row input {
  flex: 1;
  min-width: 0;
  font-size: 0.88rem;
}
</style>
