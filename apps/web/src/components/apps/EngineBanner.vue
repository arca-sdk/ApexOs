<script setup lang="ts">
/** Explains why apps can't run: no apps pool chosen, or the TrueNAS app engine (Docker) isn't running. */
import { computed } from 'vue';
import type { AppsResponse } from '@hearth/api-types';

const props = defineProps<{ engine: AppsResponse['engine'] }>();

const view = computed(() => {
  const { status, pool, description } = props.engine;
  if (!pool) {
    return {
      cls: 'warn',
      title: "Apps don't have a home yet",
      text: 'Apps keep their settings and data on a storage pool, and none is set up for them. Create a pool on the Storage page (or finish setting up your server) to start installing apps.',
      link: { to: '/storage', label: 'Go to Storage' },
    };
  }
  switch (status) {
    case 'RUNNING':
      return null;
    case 'INITIALIZING':
    case 'PENDING':
      return { cls: '', title: 'The app engine is starting', text: 'Your apps will be ready in a moment. This page updates by itself.', link: null };
    case 'STOPPING':
      return { cls: '', title: 'The app engine is stopping', text: 'Apps are being shut down.', link: null };
    case 'UNKNOWN':
      return { cls: 'warn', title: "Couldn't check the app engine", text: 'Hearth could not ask TrueNAS whether apps are running. Try again in a moment.', link: null };
    default:
      return {
        cls: 'err',
        title: "The app engine isn't running",
        text: `Apps can't start until it is running again. ${description ? `TrueNAS says: “${description}”. ` : ''}Check that the ${pool} pool is healthy.`,
        link: { to: '/storage', label: 'Check storage' },
      };
  }
});
</script>

<template>
  <div v-if="view" class="callout engine" :class="view.cls" role="status">
    <strong>{{ view.title }}</strong>
    <p>{{ view.text }}</p>
    <RouterLink v-if="view.link" :to="view.link.to" class="btn small">{{ view.link.label }}</RouterLink>
  </div>
</template>

<style scoped>
.engine {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-start;
}
</style>
