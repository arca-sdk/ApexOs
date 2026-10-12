<script setup lang="ts">
/**
 * Slide-in details panel (right side on wide screens, full width on phones).
 * Escape closes it only when it is the topmost dialog, so confirmations opened from it close first.
 */
import { nextTick, onBeforeUnmount, onMounted, ref, useId } from 'vue';
import { X } from 'lucide-vue-next';

defineProps<{ title: string; subtitle?: string }>();
const emit = defineEmits<{ close: [] }>();

const panel = ref<HTMLElement | null>(null);
const titleId = `panel-title-${useId()}`;
let returnFocus: HTMLElement | null = null;

function isTopmost(): boolean {
  const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
  return dialogs[dialogs.length - 1] === panel.value;
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && isTopmost()) emit('close');
}

onMounted(async () => {
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  window.addEventListener('keydown', onKey);
  await nextTick();
  panel.value?.focus();
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  returnFocus?.focus?.();
});
</script>

<template>
  <Teleport to="body">
    <div class="panel-backdrop" @mousedown.self="emit('close')">
      <aside ref="panel" class="side-panel" role="dialog" aria-modal="true" :aria-labelledby="titleId" tabindex="-1">
        <header class="row panel-header">
          <div class="stack" style="--gap: 2px; min-width: 0">
            <h2 :id="titleId" class="panel-title">{{ title }}</h2>
            <p v-if="subtitle" class="small muted">{{ subtitle }}</p>
            <slot name="badges" />
          </div>
          <span class="spacer" />
          <button class="btn ghost small" aria-label="Close" @click="emit('close')"><X :size="18" /></button>
        </header>
        <div class="panel-body stack" style="--gap: 18px">
          <slot />
        </div>
        <footer v-if="$slots.footer" class="row wrap panel-footer">
          <slot name="footer" />
        </footer>
      </aside>
    </div>
  </Teleport>
</template>

<style scoped>
.panel-backdrop {
  position: fixed;
  inset: 0;
  background: rgb(0 0 0 / 0.35);
  z-index: 90;
  display: flex;
  justify-content: flex-end;
}
.side-panel {
  width: min(480px, 100vw);
  height: 100%;
  background: var(--surface);
  border-left: 1px solid var(--border);
  box-shadow: var(--shadow);
  display: flex;
  flex-direction: column;
  outline: none;
  animation: slide-in 0.18s ease-out;
}
@keyframes slide-in {
  from {
    transform: translateX(24px);
    opacity: 0.6;
  }
}
@media (prefers-reduced-motion: reduce) {
  .side-panel {
    animation: none;
  }
}
.panel-header {
  align-items: flex-start;
  padding: 20px 20px 14px;
  border-bottom: 1px solid var(--border);
}
.panel-title {
  overflow-wrap: anywhere;
}
.panel-body {
  padding: 18px 20px;
  overflow-y: auto;
  flex: 1;
}
.panel-footer {
  padding: 14px 20px;
  border-top: 1px solid var(--border);
  --gap: 8px;
}
</style>
