<script setup lang="ts" generic="T extends string">
/** A large radio option rendered as a card (native radio input, so keyboard and screen readers just work). */
import type { Component } from 'vue';

defineProps<{
  name: string;
  value: T;
  title: string;
  description?: string;
  icon?: Component;
  badge?: string;
  disabled?: boolean;
  disabledReason?: string;
}>();
const model = defineModel<T | null>({ required: true });
</script>

<template>
  <label class="choice" :class="{ on: model === value, off: disabled }">
    <input v-model="model" type="radio" :name="name" :value="value" :disabled="disabled" class="radio" />
    <component :is="icon" v-if="icon" :size="22" class="icon" aria-hidden="true" />
    <span class="text">
      <span class="row title" style="--gap: 8px">
        <strong>{{ title }}</strong>
        <span v-if="badge" class="badge accent">{{ badge }}</span>
      </span>
      <span v-if="description" class="small muted">{{ description }}</span>
      <span v-if="disabled && disabledReason" class="small reason">{{ disabledReason }}</span>
      <slot />
    </span>
  </label>
</template>

<style scoped>
.choice {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding: 16px 18px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  cursor: pointer;
  transition:
    border-color 0.12s,
    background 0.12s;
}
.choice:hover:not(.off) {
  border-color: var(--accent);
}
.choice.on {
  border-color: var(--accent);
  background: var(--accent-soft);
  box-shadow: 0 0 0 1px var(--accent);
}
.choice.off {
  cursor: not-allowed;
  opacity: 0.65;
}
.choice:has(.radio:focus-visible) {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.radio {
  margin-top: 4px;
  flex: none;
}
.icon {
  flex: none;
  color: var(--accent-strong);
  margin-top: 1px;
}
.text {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.title {
  flex-wrap: wrap;
}
.reason {
  color: var(--warn);
}
</style>
