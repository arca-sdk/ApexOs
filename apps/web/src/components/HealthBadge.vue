<script setup lang="ts">
import { computed } from 'vue';
import type { PoolHealth } from '@apexos/api-types';

const props = defineProps<{ health: PoolHealth }>();
const view = computed(
  () =>
    ({
      healthy: { cls: 'ok', text: 'Healthy' },
      degraded: { cls: 'warn', text: 'Degraded' },
      rebuilding: { cls: 'info', text: 'Rebuilding' },
      offline: { cls: 'err', text: 'Offline' },
      errors: { cls: 'err', text: 'Errors found' },
      unknown: { cls: '', text: 'Unknown' },
    })[props.health],
);
</script>

<template>
  <span class="badge" :class="view.cls">{{ view.text }}</span>
</template>
