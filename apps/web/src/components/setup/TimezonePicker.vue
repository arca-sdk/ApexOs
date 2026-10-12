<script setup lang="ts">
/** Searchable time zone picker (ARIA combobox with a listbox of matches). */
import { computed, nextTick, ref, watch } from 'vue';
import { ChevronDown } from 'lucide-vue-next';

const props = defineProps<{ choices: string[]; id: string; describedby?: string }>();
const model = defineModel<string>({ required: true });

const query = ref('');
const open = ref(false);
const active = ref(0);
const list = ref<HTMLElement | null>(null);
const listId = `${props.id}-list`;

/** "America/Argentina/Buenos_Aires" → "America / Argentina / Buenos Aires" */
function pretty(tz: string): string {
  return tz.replace(/_/g, ' ').replace(/\//g, ' / ');
}

const matches = computed(() => {
  const q = query.value.trim().toLowerCase().replace(/[\s_/]+/g, ' ');
  if (!q) return props.choices;
  const words = q.split(' ');
  return props.choices.filter((tz) => {
    const hay = tz.toLowerCase().replace(/[_/]+/g, ' ');
    return words.every((w) => hay.includes(w));
  });
});
const shown = computed(() => matches.value.slice(0, 200));

watch(query, () => (active.value = 0));

function openList() {
  if (open.value) return;
  open.value = true;
  const i = shown.value.indexOf(model.value);
  active.value = i >= 0 ? i : 0;
  void scrollActive();
}

function close() {
  open.value = false;
  query.value = '';
}

function choose(tz: string) {
  model.value = tz;
  close();
}

async function scrollActive() {
  await nextTick();
  list.value?.querySelector<HTMLElement>(`[data-index="${active.value}"]`)?.scrollIntoView({ block: 'nearest' });
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!open.value) return openList();
    const n = shown.value.length;
    if (!n) return;
    active.value = (active.value + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
    void scrollActive();
  } else if (e.key === 'Enter') {
    if (open.value && shown.value[active.value]) {
      e.preventDefault();
      choose(shown.value[active.value]!);
    }
  } else if (e.key === 'Escape') {
    if (open.value) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }
}

function onInput(e: Event) {
  query.value = (e.target as HTMLInputElement).value;
  open.value = true;
}

function onBlur() {
  // Let a click on an option land before closing.
  setTimeout(close, 150);
}
</script>

<template>
  <div class="tz">
    <div class="input-wrap">
      <input
        :id="id"
        type="text"
        role="combobox"
        autocomplete="off"
        spellcheck="false"
        :aria-expanded="open"
        :aria-controls="listId"
        aria-autocomplete="list"
        :aria-activedescendant="open && shown.length ? `${id}-opt-${active}` : undefined"
        :aria-describedby="describedby"
        :value="open ? query : pretty(model)"
        :placeholder="open ? pretty(model) || 'Type a city or region' : ''"
        @focus="openList"
        @click="openList"
        @input="onInput"
        @keydown="onKey"
        @blur="onBlur"
      />
      <ChevronDown :size="16" class="chev" aria-hidden="true" />
    </div>
    <ul v-show="open" :id="listId" ref="list" class="card list" role="listbox" :aria-label="'Time zones'">
      <li
        v-for="(tz, i) in shown"
        :id="`${id}-opt-${i}`"
        :key="tz"
        role="option"
        :data-index="i"
        :aria-selected="tz === model"
        :class="{ active: i === active, selected: tz === model }"
        @mousedown.prevent="choose(tz)"
        @mousemove="active = i"
      >
        {{ pretty(tz) }}
      </li>
      <li v-if="!shown.length" class="empty muted small" role="presentation">No time zone matches “{{ query }}”.</li>
      <li v-else-if="matches.length > shown.length" class="empty muted small" role="presentation">Keep typing to narrow down {{ matches.length }} matches.</li>
    </ul>
  </div>
</template>

<style scoped>
.tz {
  position: relative;
}
.input-wrap {
  position: relative;
}
.input-wrap input {
  padding-right: 34px;
}
.chev {
  position: absolute;
  right: 12px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-muted);
  pointer-events: none;
}
.list {
  position: absolute;
  z-index: 30;
  left: 0;
  right: 0;
  top: calc(100% + 4px);
  max-height: 280px;
  overflow: auto;
  margin: 0;
  padding: 4px;
  list-style: none;
}
.list li {
  padding: 7px 10px;
  border-radius: 6px;
  cursor: pointer;
}
.list li.active {
  background: var(--surface-2);
}
.list li.selected {
  font-weight: 600;
  color: var(--accent-strong);
}
.list li.empty {
  cursor: default;
}
</style>
