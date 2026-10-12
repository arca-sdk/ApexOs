<script setup lang="ts">
/** Small keyboard-accessible "more actions" menu button. */
import { nextTick, onBeforeUnmount, ref, type Component } from 'vue';
import { Ellipsis } from 'lucide-vue-next';

export interface MenuItem {
  key: string;
  label: string;
  icon?: Component;
  danger?: boolean;
  disabled?: boolean;
  hint?: string;
}

defineProps<{ items: MenuItem[]; label: string }>();
const emit = defineEmits<{ select: [key: string] }>();

const open = ref(false);
const root = ref<HTMLElement | null>(null);
const button = ref<HTMLButtonElement | null>(null);
const menuId = `menu-${Math.random().toString(36).slice(2, 9)}`;

function itemEls(): HTMLButtonElement[] {
  return [...(root.value?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? [])];
}

async function show(focusLast = false) {
  open.value = true;
  document.addEventListener('mousedown', onOutside);
  await nextTick();
  const els = itemEls();
  (focusLast ? els[els.length - 1] : els[0])?.focus();
}

function hide(returnFocus = true) {
  open.value = false;
  document.removeEventListener('mousedown', onOutside);
  if (returnFocus) button.value?.focus();
}

function onOutside(e: MouseEvent) {
  if (root.value && !root.value.contains(e.target as Node)) hide(false);
}

function onMenuKey(e: KeyboardEvent) {
  const els = itemEls();
  const i = els.indexOf(document.activeElement as HTMLButtonElement);
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    els[(i + 1) % els.length]?.focus();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    els[(i - 1 + els.length) % els.length]?.focus();
  } else if (e.key === 'Home') {
    e.preventDefault();
    els[0]?.focus();
  } else if (e.key === 'End') {
    e.preventDefault();
    els[els.length - 1]?.focus();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    hide();
  } else if (e.key === 'Tab') {
    hide(false);
  }
}

function onButtonKey(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    void show();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    void show(true);
  }
}

function choose(item: MenuItem) {
  if (item.disabled) return;
  hide();
  emit('select', item.key);
}

onBeforeUnmount(() => document.removeEventListener('mousedown', onOutside));
</script>

<template>
  <div ref="root" class="more">
    <button
      ref="button"
      class="btn small"
      type="button"
      aria-haspopup="menu"
      :aria-expanded="open"
      :aria-controls="menuId"
      :aria-label="label"
      :title="label"
      @click="open ? hide() : show()"
      @keydown="onButtonKey"
    >
      <Ellipsis :size="16" aria-hidden="true" />
    </button>
    <div v-if="open" :id="menuId" class="card menu" role="menu" :aria-label="label" @keydown="onMenuKey">
      <button
        v-for="item in items"
        :key="item.key"
        type="button"
        role="menuitem"
        class="item"
        :class="{ danger: item.danger }"
        :disabled="item.disabled"
        :title="item.hint"
        @click="choose(item)"
      >
        <component :is="item.icon" v-if="item.icon" :size="16" aria-hidden="true" />
        <span>{{ item.label }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.more {
  position: relative;
}
.menu {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  z-index: 20;
  min-width: 200px;
  padding: 6px;
  display: flex;
  flex-direction: column;
}
.item {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--text);
  font: inherit;
  text-align: left;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
}
.item:hover:not(:disabled),
.item:focus-visible {
  background: var(--surface-2);
  outline: none;
}
.item:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.item.danger {
  color: var(--err);
}
</style>
