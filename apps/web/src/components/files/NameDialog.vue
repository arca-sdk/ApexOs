<script setup lang="ts">
/**
 * Asks for a name (new folder, rename). Renaming a file pre-selects the part before the extension and
 * asks before the extension changes. The dialog stays open until the server answers and keeps the
 * typed name when something goes wrong.
 */
import { computed, nextTick, onMounted, ref } from 'vue';
import Modal from '../Modal.vue';
import { splitExtension } from './files.ts';

const props = defineProps<{
  title: string;
  label: string;
  actionLabel: string;
  initial?: string;
  /** Renaming a file: pre-select the base name and confirm extension changes. */
  isFile?: boolean;
  busy?: boolean;
  error?: string | null;
}>();
const emit = defineEmits<{ submit: [name: string]; close: [] }>();

const name = ref(props.initial ?? '');
const input = ref<HTMLInputElement | null>(null);
const localError = ref<string | null>(null);
const confirmExt = ref<{ from: string; to: string } | null>(null);

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function problem(value: string): string | null {
  if (!value) return 'Enter a name.';
  if (value === '.' || value === '..') return 'That name is reserved.';
  if (value.includes('/')) return 'Names can’t contain “/”.';
  if (CONTROL.test(value)) return 'Names can’t contain line breaks or other invisible characters.';
  if (new TextEncoder().encode(value).length > 255) return 'That name is too long.';
  if (value.toLowerCase() === '.zfs') return 'That name is reserved for snapshots.';
  return null;
}

const shownError = computed(() => localError.value ?? props.error ?? null);

onMounted(async () => {
  await nextTick();
  const el = input.value;
  if (!el) return;
  el.focus();
  const [base] = props.isFile ? splitExtension(name.value) : [name.value];
  el.setSelectionRange(0, base.length);
});

function submit(force = false) {
  if (props.busy) return;
  const value = name.value.trim();
  name.value = value;
  localError.value = problem(value);
  if (localError.value) return;
  if (props.isFile && props.initial && !force) {
    const from = splitExtension(props.initial)[1];
    const to = splitExtension(value)[1];
    if (from.toLowerCase() !== to.toLowerCase()) {
      confirmExt.value = { from, to };
      return;
    }
  }
  confirmExt.value = null;
  emit('submit', value);
}

function keepExtension() {
  const ext = confirmExt.value?.from ?? '';
  name.value = splitExtension(name.value)[0] + ext;
  confirmExt.value = null;
  submit(true);
}
</script>

<template>
  <Modal :title="title" @close="emit('close')">
    <form class="stack" style="--gap: 12px" @submit.prevent="submit()">
      <div class="field">
        <label for="file-name-input">{{ label }}</label>
        <input
          id="file-name-input"
          ref="input"
          v-model="name"
          type="text"
          autocomplete="off"
          spellcheck="false"
          :aria-invalid="!!shownError"
          :aria-describedby="shownError ? 'file-name-error' : undefined"
          :disabled="busy"
          @input="localError = null; confirmExt = null"
        />
        <p v-if="shownError" id="file-name-error" class="error-text" role="alert">{{ shownError }}</p>
      </div>
      <div v-if="confirmExt" class="callout warn stack" style="--gap: 10px" role="alert">
        <p>
          <template v-if="confirmExt.from && confirmExt.to">Change the ending from <strong>{{ confirmExt.from }}</strong> to <strong>{{ confirmExt.to }}</strong>?</template>
          <template v-else-if="confirmExt.from">Remove the ending <strong>{{ confirmExt.from }}</strong>?</template>
          <template v-else>Add the ending <strong>{{ confirmExt.to }}</strong>?</template>
          Apps decide how to open a file by its ending, so it may not open the same way afterwards.
        </p>
        <div class="row wrap" style="--gap: 8px">
          <button type="button" class="btn small" @click="keepExtension">Keep {{ confirmExt.from || 'no ending' }}</button>
          <button type="button" class="btn small primary" @click="submit(true)">Use {{ confirmExt.to || 'no ending' }}</button>
        </div>
      </div>
      <button type="submit" hidden />
    </form>
    <template #footer>
      <button class="btn" type="button" @click="emit('close')">Cancel</button>
      <button class="btn primary" type="button" :disabled="busy || !!confirmExt" @click="submit()"><span v-if="busy" class="spin" />{{ actionLabel }}</button>
    </template>
  </Modal>
</template>
