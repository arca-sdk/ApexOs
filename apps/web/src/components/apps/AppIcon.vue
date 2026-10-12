<script setup lang="ts">
/** Remote app icon with a coloured-initial fallback when it is missing or fails to load. */
import { computed, ref, watch } from 'vue';

const props = withDefaults(defineProps<{ src: string | null; title: string; size?: number }>(), { size: 44 });
const failed = ref(false);
watch(
  () => props.src,
  () => (failed.value = false),
);

const initial = computed(() => (props.title.trim()[0] ?? '?').toUpperCase());
/** Stable hue per app so fallbacks are distinguishable from each other. */
const hue = computed(() => [...props.title].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7));
</script>

<template>
  <span class="app-icon" :style="{ width: `${size}px`, height: `${size}px`, '--hue': hue }" aria-hidden="true">
    <img v-if="src && !failed" :src="src" alt="" loading="lazy" referrerpolicy="no-referrer" @error="failed = true" />
    <span v-else class="fallback" :style="{ fontSize: `${Math.round(size * 0.45)}px` }">{{ initial }}</span>
  </span>
</template>

<style scoped>
.app-icon {
  flex: none;
  display: inline-grid;
  place-items: center;
  border-radius: 22%;
  overflow: hidden;
  background: var(--surface-2);
  border: 1px solid var(--border);
}
img {
  width: 78%;
  height: 78%;
  object-fit: contain;
}
.fallback {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  font-weight: 700;
  color: hsl(var(--hue) 45% 32%);
  background: hsl(var(--hue) 60% 90%);
}
@media (prefers-color-scheme: dark) {
  .fallback {
    color: hsl(var(--hue) 60% 82%);
    background: hsl(var(--hue) 30% 22%);
  }
}
</style>
