<script setup lang="ts">
import { computed } from 'vue';
import type { AppState } from '@hearth/api-types';

const props = defineProps<{ state: AppState }>();
const view = computed(
  () =>
    ({
      running: { cls: 'ok', text: 'Running', busy: false },
      stopped: { cls: '', text: 'Stopped', busy: false },
      deploying: { cls: 'info', text: 'Starting', busy: true },
      stopping: { cls: 'info', text: 'Stopping', busy: true },
      crashed: { cls: 'err', text: 'Crashed', busy: false },
      unknown: { cls: 'warn', text: 'Unknown', busy: false },
    })[props.state] ?? { cls: 'warn', text: 'Unknown', busy: false },
);
</script>

<template>
  <span class="badge" :class="view.cls">
    <span v-if="view.busy" class="spin" style="width: 10px; height: 10px; border-width: 1.5px" aria-hidden="true" />
    <span v-else class="dot" aria-hidden="true" />
    {{ view.text }}
  </span>
</template>

<style scoped>
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
}
</style>
