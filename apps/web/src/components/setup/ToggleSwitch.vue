<script setup lang="ts">
/** Accessible on/off switch (button with role="switch"); the parent decides what a change means. */
defineProps<{ checked: boolean; label: string; disabled?: boolean }>();
const emit = defineEmits<{ toggle: [next: boolean] }>();
</script>

<template>
  <button
    type="button"
    role="switch"
    class="switch-row"
    :aria-checked="checked"
    :disabled="disabled"
    @click="emit('toggle', !checked)"
  >
    <span class="track" :class="{ on: checked }" aria-hidden="true"><span class="thumb" /></span>
    <span class="label">{{ label }}</span>
  </button>
</template>

<style scoped>
.switch-row {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-weight: 550;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 4px 2px;
  cursor: pointer;
  border-radius: 6px;
}
.switch-row:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.switch-row:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
.track {
  width: 40px;
  height: 22px;
  border-radius: 999px;
  background: var(--border);
  position: relative;
  transition: background 0.15s;
  flex: none;
}
.track.on {
  background: var(--accent);
}
.thumb {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.25);
  transition: transform 0.15s;
}
.track.on .thumb {
  transform: translateX(18px);
}
</style>
