<script setup lang="ts">
/**
 * A menu shown at a point (right-click, Shift+F10 / Menu key, or a row's ⋮ button).
 * Arrow keys move, Enter chooses, Escape or Tab closes and returns focus.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, type Component } from 'vue';
import { Check } from 'lucide-vue-next';

export interface ContextItem {
  key: string;
  label: string;
  icon?: Component;
  danger?: boolean;
  disabled?: boolean;
  hint?: string;
  /** Set for on/off options: shown with a check mark and announced as checked or not. */
  checked?: boolean;
}

const props = defineProps<{ x: number; y: number; items: ContextItem[]; label: string }>();
const emit = defineEmits<{ select: [key: string]; close: [] }>();

const menu = ref<HTMLElement | null>(null);
/** Keep labels aligned when only some items have an icon (e.g. check marks). */
const withIcons = computed(() => props.items.some((i) => i.icon || i.checked !== undefined));
const pos = ref({ left: props.x, top: props.y });
let returnFocus: HTMLElement | null = null;

function itemEls(): HTMLButtonElement[] {
  return [...(menu.value?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not([disabled])') ?? [])];
}

function close(restore = true) {
  emit('close');
  if (restore) returnFocus?.focus?.();
}

function onKey(e: KeyboardEvent) {
  const els = itemEls();
  const i = els.indexOf(document.activeElement as HTMLButtonElement);
  if (e.key === 'ArrowDown') els[(i + 1) % els.length]?.focus();
  else if (e.key === 'ArrowUp') els[(i - 1 + els.length) % els.length]?.focus();
  else if (e.key === 'Home') els[0]?.focus();
  else if (e.key === 'End') els[els.length - 1]?.focus();
  else if (e.key === 'Escape') close();
  else if (e.key === 'Tab') close();
  else return;
  e.preventDefault();
  e.stopPropagation();
}

function onOutside(e: MouseEvent) {
  if (menu.value && !menu.value.contains(e.target as Node)) close(false);
}

function choose(item: ContextItem) {
  if (item.disabled) return;
  close();
  emit('select', item.key);
}

onMounted(async () => {
  returnFocus = document.activeElement as HTMLElement | null;
  document.addEventListener('mousedown', onOutside, true);
  window.addEventListener('resize', onWindowChange);
  window.addEventListener('scroll', onWindowChange, true);
  await nextTick();
  // Keep the menu on screen.
  const rect = menu.value?.getBoundingClientRect();
  if (rect) {
    pos.value = {
      left: Math.max(8, Math.min(props.x, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(props.y, window.innerHeight - rect.height - 8)),
    };
  }
  itemEls()[0]?.focus();
});

function onWindowChange() {
  close(false);
}

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onOutside, true);
  window.removeEventListener('resize', onWindowChange);
  window.removeEventListener('scroll', onWindowChange, true);
});
</script>

<template>
  <Teleport to="body">
    <div ref="menu" class="card context-menu" role="menu" :aria-label="label" :style="{ left: `${pos.left}px`, top: `${pos.top}px` }" @keydown="onKey" @contextmenu.prevent>
      <button
        v-for="item in items"
        :key="item.key"
        type="button"
        :role="item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'"
        :aria-checked="item.checked === undefined ? undefined : item.checked"
        class="item"
        :class="{ danger: item.danger }"
        :disabled="item.disabled"
        :title="item.hint"
        @click="choose(item)"
      >
        <Check v-if="item.checked" :size="16" aria-hidden="true" class="icon" />
        <component :is="item.icon" v-else-if="item.icon" :size="16" aria-hidden="true" class="icon" />
        <span v-else-if="withIcons" class="icon" aria-hidden="true" />
        <span>{{ item.label }}</span>
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.context-menu {
  position: fixed;
  z-index: 120;
  min-width: 190px;
  max-width: calc(100vw - 16px);
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
.icon {
  flex: none;
  width: 16px;
}
.item.danger {
  color: var(--err);
}
</style>
