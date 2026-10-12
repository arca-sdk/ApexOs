<script setup lang="ts">
import type { Pool } from '@hearth/api-types';
import { formatBytes, toleranceText } from '../../lib/format.ts';
import CapacityRing from '../CapacityRing.vue';
import HealthBadge from '../HealthBadge.vue';

defineProps<{ pool: Pool }>();

const SCAN_LABELS = { scrub: 'Checking data', resilver: 'Rebuilding', expand: 'Expanding' } as const;
</script>

<template>
  <RouterLink to="/storage" class="card pool">
    <CapacityRing :used="pool.usedBytes" :total="pool.sizeBytes" :size="72" />
    <div class="info">
      <div class="row wrap" style="--gap: 6px">
        <strong class="name" :title="pool.displayName">{{ pool.displayName }}</strong>
        <HealthBadge :health="pool.health" />
      </div>
      <div class="small">
        <strong>{{ formatBytes(pool.usedBytes) }}</strong> <span class="muted">used of {{ formatBytes(pool.sizeBytes) }}</span>
      </div>
      <div class="small muted">
        {{ pool.layout.label }} · {{ toleranceText(pool.layout.faultTolerance) }}<template v-if="pool.isAppsPool"> · Apps live here</template>
      </div>
      <div v-if="pool.scan?.state === 'running'" class="small scan">
        <span class="spin tiny" aria-hidden="true" /> {{ SCAN_LABELS[pool.scan.kind] }} · {{ Math.round(pool.scan.percent) }}%
      </div>
      <p v-else-if="pool.health !== 'healthy' && pool.healthDetail" class="small detail">{{ pool.healthDetail }}</p>
    </div>
  </RouterLink>
</template>

<style scoped>
.pool {
  display: flex;
  align-items: center;
  gap: 16px;
  color: inherit;
  min-width: 0;
  transition: border-color 0.12s;
}
.pool:hover {
  text-decoration: none;
  border-color: var(--accent);
}
.pool:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.info {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
.scan {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--info);
}
.detail {
  color: var(--warn);
}
.tiny {
  width: 11px;
  height: 11px;
  border-width: 1.5px;
}
</style>
