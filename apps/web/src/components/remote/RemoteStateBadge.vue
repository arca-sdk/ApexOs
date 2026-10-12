<script setup lang="ts">
/** On/off badge for a remote access method, with the app's state when it isn't simply running. */
import { computed } from 'vue';
import type { RemoteAppState } from '@apexos/api-types';

const props = defineProps<{ enabled: boolean; state: RemoteAppState | null }>();

const view = computed(() => {
  if (!props.enabled) return { cls: '', label: 'Off' };
  switch (props.state) {
    case 'running':
      return { cls: 'ok', label: 'On' };
    case 'deploying':
      return { cls: 'info', label: 'Starting' };
    case 'stopping':
    case 'stopped':
      return { cls: 'warn', label: 'Stopped' };
    case 'crashed':
      return { cls: 'err', label: 'Not working' };
    case 'missing':
      return { cls: 'err', label: 'Removed' };
    default:
      return { cls: 'warn', label: 'Unknown' };
  }
});
</script>

<template>
  <span class="badge" :class="view.cls" role="status">{{ view.label }}</span>
</template>
