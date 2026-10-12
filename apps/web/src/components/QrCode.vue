<script setup lang="ts">
/** QR code drawn from server-made SVG path data; always dark on white (also in dark mode) so phones can read it. */
defineProps<{ size: number; path: string; label: string }>();
</script>

<template>
  <svg class="qr" :viewBox="`-4 -4 ${size + 8} ${size + 8}`" role="img" :aria-label="label" shape-rendering="crispEdges">
    <rect x="-4" y="-4" :width="size + 8" :height="size + 8" fill="#fff" />
    <path :d="path" fill="#000" />
  </svg>
</template>

<style scoped>
.qr {
  display: block;
  width: 100%;
  max-width: 220px;
  height: auto;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
}
</style>
