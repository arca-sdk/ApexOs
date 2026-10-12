<script setup lang="ts">
/** Info panel that slides in from the right (a bottom sheet on phones). Escape or the backdrop closes it. */
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { X } from 'lucide-vue-next';

defineProps<{ title: string }>();
const emit = defineEmits<{ close: [] }>();
const closeBtn = ref<HTMLButtonElement | null>(null);
let returnFocus: HTMLElement | null = null;

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close');
}
onMounted(async () => {
  returnFocus = document.activeElement as HTMLElement | null;
  window.addEventListener('keydown', onKey);
  await nextTick();
  closeBtn.value?.focus();
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  returnFocus?.focus?.();
});
</script>

<template>
  <Teleport to="body">
    <div class="backdrop" @mousedown.self="emit('close')">
      <aside class="panel" role="dialog" aria-modal="true" :aria-label="title">
        <div class="row head">
          <h2>{{ title }}</h2>
          <span class="spacer" />
          <button ref="closeBtn" class="btn ghost small" aria-label="Close" @click="emit('close')"><X :size="18" /></button>
        </div>
        <div class="body stack">
          <slot />
        </div>
      </aside>
    </div>
  </Teleport>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  background: rgb(0 0 0 / 0.35);
  z-index: 100;
  display: flex;
  justify-content: flex-end;
}
.panel {
  width: min(460px, 100%);
  height: 100%;
  background: var(--surface);
  border-left: 1px solid var(--border);
  box-shadow: var(--shadow);
  display: flex;
  flex-direction: column;
  animation: slide-in 0.18s ease-out;
}
.head {
  padding: 18px 20px 14px;
  border-bottom: 1px solid var(--border);
}
.body {
  padding: 18px 20px 28px;
  overflow: auto;
}
@keyframes slide-in {
  from {
    transform: translateX(24px);
    opacity: 0;
  }
}
@media (max-width: 600px) {
  .backdrop {
    align-items: flex-end;
  }
  .panel {
    height: auto;
    max-height: 85vh;
    border-left: 0;
    border-top: 1px solid var(--border);
    border-radius: var(--radius) var(--radius) 0 0;
    animation-name: slide-up;
  }
  @keyframes slide-up {
    from {
      transform: translateY(24px);
      opacity: 0;
    }
  }
}
</style>
