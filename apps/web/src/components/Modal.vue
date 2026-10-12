<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { X } from 'lucide-vue-next';

defineProps<{ title: string; wide?: boolean }>();
const emit = defineEmits<{ close: [] }>();

/** Open modals, innermost last; only the topmost one reacts to Escape. */
const stack: symbol[] = ((globalThis as { __apexosModals?: symbol[] }).__apexosModals ??= []);
const id = Symbol('modal');
const dialog = ref<HTMLElement | null>(null);
let previousFocus: HTMLElement | null = null;

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function onKey(e: KeyboardEvent) {
  if (stack.at(-1) !== id) return;
  if (e.key === 'Escape') {
    e.stopPropagation();
    emit('close');
  } else if (e.key === 'Tab' && dialog.value) {
    // Keep keyboard focus inside the dialog.
    const items = [...dialog.value.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0]!;
    const last = items.at(-1)!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
}

onMounted(async () => {
  previousFocus = document.activeElement as HTMLElement | null;
  stack.push(id);
  window.addEventListener('keydown', onKey);
  await nextTick();
  const body = dialog.value?.querySelector<HTMLElement>('.modal-body');
  const target = body?.querySelector<HTMLElement>('[autofocus]') ?? body?.querySelector<HTMLElement>(FOCUSABLE) ?? dialog.value;
  target?.focus();
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  const i = stack.indexOf(id);
  if (i >= 0) stack.splice(i, 1);
  previousFocus?.focus?.();
});
</script>

<template>
  <Teleport to="body">
    <div class="backdrop" @mousedown.self="emit('close')">
      <div ref="dialog" class="card modal" :class="{ wide }" role="dialog" aria-modal="true" :aria-label="title" tabindex="-1">
        <div class="row modal-header">
          <h2>{{ title }}</h2>
          <span class="spacer" />
          <button class="btn ghost small" aria-label="Close" @click="emit('close')"><X :size="18" /></button>
        </div>
        <div class="modal-body stack">
          <slot />
        </div>
        <div v-if="$slots.footer" class="row modal-footer">
          <span class="spacer" />
          <slot name="footer" />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  background: rgb(0 0 0 / 0.45);
  display: grid;
  place-items: center;
  padding: 20px;
  z-index: 100;
}
.modal {
  width: min(520px, 100%);
  max-height: calc(100vh - 40px);
  overflow: auto;
  padding: 22px 24px;
}
.modal:focus {
  outline: none;
}
.modal.wide {
  width: min(760px, 100%);
}
.modal-header {
  margin-bottom: 18px;
}
.modal-footer {
  margin-top: 22px;
  flex-wrap: wrap;
}
@media (max-width: 480px) {
  .backdrop {
    padding: 8px;
  }
  .modal {
    padding: 18px 16px;
  }
}
</style>
