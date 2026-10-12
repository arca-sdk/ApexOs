<script setup lang="ts">
/** Pinned notice about TrueNAS itself: an available update, or a version Hearth doesn't support. */
import { ArrowRight, Download, TriangleAlert } from 'lucide-vue-next';
import type { UpdateInfo } from '@hearth/api-types';

defineProps<{ update: UpdateInfo }>();
</script>

<template>
  <div v-if="update.available" class="callout banner" role="status">
    <Download :size="18" class="b-icon info" aria-hidden="true" />
    <div class="text">
      <strong>TrueNAS {{ update.available.version }} is available</strong>
      <span class="small">
        You're on {{ update.currentVersion }}. The server restarts to finish the update.
        <template v-if="update.riskWarning"> {{ update.riskWarning }}</template>
      </span>
    </div>
    <RouterLink to="/settings" class="btn small">Review update <ArrowRight :size="14" /></RouterLink>
  </div>
  <div v-if="!update.supported && update.supportNote" class="callout warn banner" role="status">
    <TriangleAlert :size="18" class="b-icon warn" aria-hidden="true" />
    <div class="text">
      <strong>This TrueNAS version isn't fully supported</strong>
      <span class="small">{{ update.supportNote }}</span>
    </div>
  </div>
</template>

<style scoped>
.banner {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px 12px;
}
.b-icon {
  flex: none;
}
.b-icon.info {
  color: var(--info);
}
.b-icon.warn {
  color: var(--warn);
}
.text {
  flex: 1;
  min-width: 200px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
</style>
