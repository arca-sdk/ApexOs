<script setup lang="ts">
/** One install-script question rendered as the right kind of input. */
import { computed, ref } from 'vue';
import { Eye, EyeOff, RefreshCw } from 'lucide-vue-next';
import type { InstallQuestion } from '@apexos/api-types';

const props = defineProps<{
  question: InstallQuestion;
  error?: string;
  /** Offer a "Generate" button (password questions that came with a random default). */
  generatable?: boolean;
}>();
const model = defineModel<string | number | boolean>();

const show = ref(false);
const id = computed(() => `q-${props.question.key}`);
const hintId = computed(() => `${id.value}-hint`);
const errId = computed(() => `${id.value}-err`);
const describedBy = computed(() => [props.question.description ? hintId.value : '', props.error ? errId.value : ''].filter(Boolean).join(' ') || undefined);

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
function generate() {
  const current = typeof model.value === 'string' ? model.value.length : 0;
  const length = Math.min(64, Math.max(16, current));
  const bytes = crypto.getRandomValues(new Uint32Array(length));
  model.value = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
}

const textValue = computed({
  get: () => (model.value === undefined || model.value === null ? '' : String(model.value)),
  set: (v: string) => (model.value = v),
});
const numberValue = computed({
  get: () => (typeof model.value === 'number' ? model.value : model.value === '' ? '' : Number(model.value)),
  set: (v: number | string) => (model.value = v === '' || v === null ? '' : Number(v)),
});
</script>

<template>
  <div v-if="question.type === 'boolean'" class="field">
    <label class="check">
      <input :id="id" v-model="model" type="checkbox" :aria-describedby="describedBy" />
      <span>{{ question.question }}</span>
    </label>
    <span v-if="question.description" :id="hintId" class="hint">{{ question.description }}</span>
    <span v-if="error" :id="errId" class="error-text">{{ error }}</span>
  </div>

  <div v-else class="field">
    <label :for="id">
      {{ question.question }}
      <span v-if="!question.required" class="muted optional">(optional)</span>
    </label>

    <select v-if="question.type === 'select'" :id="id" v-model="model" :aria-describedby="describedBy" :aria-invalid="!!error" :required="question.required">
      <option v-if="!question.required" value="">Not set</option>
      <option v-for="o in question.options ?? []" :key="String(o.value)" :value="o.value">{{ o.text }}</option>
    </select>

    <input
      v-else-if="question.type === 'number'"
      :id="id"
      v-model="numberValue"
      type="number"
      inputmode="numeric"
      :placeholder="question.placeholder"
      :required="question.required"
      :aria-describedby="describedBy"
      :aria-invalid="!!error"
    />

    <div v-else-if="question.type === 'password'" class="password">
      <input
        :id="id"
        v-model="textValue"
        :type="show ? 'text' : 'password'"
        :class="{ shown: show }"
        autocomplete="new-password"
        spellcheck="false"
        :placeholder="question.placeholder"
        :required="question.required"
        :aria-describedby="describedBy"
        :aria-invalid="!!error"
      />
      <button type="button" class="btn small" :aria-pressed="show" :aria-label="show ? 'Hide password' : 'Show password'" :title="show ? 'Hide' : 'Show'" @click="show = !show">
        <EyeOff v-if="show" :size="15" />
        <Eye v-else :size="15" />
      </button>
      <button v-if="generatable" type="button" class="btn small" :aria-label="`Generate a new random ${question.question.toLowerCase()}`" title="Generate a new one" @click="generate">
        <RefreshCw :size="15" /> <span class="gen-label">Generate</span>
      </button>
    </div>

    <input
      v-else
      :id="id"
      v-model="textValue"
      type="text"
      :placeholder="question.placeholder"
      :required="question.required"
      :aria-describedby="describedBy"
      :aria-invalid="!!error"
    />

    <span v-if="question.description" :id="hintId" class="hint">{{ question.description }}</span>
    <span v-if="error" :id="errId" class="error-text">{{ error }}</span>
  </div>
</template>

<style scoped>
.check {
  display: flex;
  gap: 10px;
  align-items: center;
  font-weight: 550;
  font-size: 0.92rem;
  cursor: pointer;
}
.optional {
  font-weight: 400;
  font-size: 0.85em;
}
.password {
  display: flex;
  gap: 6px;
}
.password input {
  flex: 1;
  min-width: 0;
}
.password input.shown {
  font-family: var(--mono);
  font-size: 0.9rem;
}
.password .btn {
  flex: none;
}
@media (max-width: 420px) {
  .gen-label {
    display: none;
  }
}
</style>
