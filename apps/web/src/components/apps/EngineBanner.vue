<script setup lang="ts">
/** Explains why apps can't run: no apps pool chosen, or the TrueNAS app engine (Docker) isn't running. */
import { computed } from 'vue';
import type { AppsResponse } from '@apexos/api-types';

const props = defineProps<{ engine: AppsResponse['engine'] }>();
const emit = defineEmits<{ choose: [] }>();

const view = computed(() => {
  const { status, pool, description } = props.engine;
  if (!pool) {
    return {
      cls: 'warn',
      title: "Apps don't have a home yet",
      text: 'Apps keep their settings and data on a storage pool, and none is set up for them. Choose one of your pools, or create a new one on the Storage page.',
      choose: true,
      link: { to: '/storage', label: 'Go to Storage' },
    };
  }
  switch (status) {
    case 'RUNNING':
      return null;
    case 'INITIALIZING':
    case 'PENDING':
      return { cls: '', title: 'The app engine is starting', text: 'Your apps will be ready in a moment. This page updates by itself.', choose: false, link: null };
    case 'STOPPING':
      return { cls: '', title: 'The app engine is stopping', text: 'Apps are being shut down.', choose: false, link: null };
    case 'MIGRATING':
      return { cls: '', title: 'Apps are moving to another pool', text: 'They are unavailable until the move is done. This page updates by itself.', choose: false, link: null };
    case 'MIGRATION_FAILED':
      return {
        cls: 'err',
        title: "Apps couldn't move to another pool",
        text: `${description ? `TrueNAS says: “${description}”. ` : ''}Their old copy is still on the pool they came from. Choose a pool for apps to try again.`,
        choose: true,
        link: null,
      };
    case 'UNKNOWN':
      return { cls: 'warn', title: "Couldn't check the app engine", text: 'ApexOs could not ask TrueNAS whether apps are running. Try again in a moment.', choose: false, link: null };
    default:
      return {
        cls: 'err',
        title: "The app engine isn't running",
        text: `Apps can't start until it is running again. ${description ? `TrueNAS says: “${description}”. ` : ''}Check that the ${pool} pool is healthy.`,
        choose: false,
        link: { to: '/storage', label: 'Check storage' },
      };
  }
});
</script>

<template>
  <div v-if="view" class="callout engine" :class="view.cls" role="status">
    <strong>{{ view.title }}</strong>
    <p>{{ view.text }}</p>
    <div v-if="view.choose || view.link" class="row wrap" style="--gap: 8px">
      <button v-if="view.choose" class="btn small primary" @click="emit('choose')">Choose a pool</button>
      <RouterLink v-if="view.link" :to="view.link.to" class="btn small">{{ view.link.label }}</RouterLink>
    </div>
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
