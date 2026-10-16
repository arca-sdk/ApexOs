<script setup lang="ts">
import { computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppLayout from './components/AppLayout.vue';
import { refreshStatus, session } from './lib/api.ts';
import { connectEvents, disconnectEvents, live } from './lib/events.ts';
import { onboardingRedirect } from './router.ts';

const route = useRoute();
const router = useRouter();
const bare = computed(() => route.meta.bare === true);

watch(
  () => session.authenticated,
  (authed) => {
    if (authed) connectEvents();
    else {
      disconnectEvents();
      if (session.loaded && !route.meta.public) router.replace(session.needsAccount ? '/welcome' : '/login');
    }
  },
  { immediate: true },
);

// When "Start over" finishes, setup runs again, wherever the user is (they may have closed its dialog).
const finishedResets = computed(() =>
  Object.values(live.tasks)
    .filter((t) => t.type === 'factory-reset' && t.status === 'success')
    .map((t) => t.id)
    .join(','),
);
watch(finishedResets, async (ids) => {
  if (!ids) return;
  try {
    await refreshStatus();
  } catch {
    // The status couldn't be read; setup is where an erased server belongs anyway.
    await router.replace('/setup');
    return;
  }
  if (!session.setupComplete) await router.replace('/setup');
});
// A reset that finished while the page was disconnected may no longer be in the task list it gets back.
watch(
  () => live.connected,
  async (connected) => {
    if (!connected) return;
    await refreshStatus().catch(() => undefined);
    if (onboardingRedirect(route) === '/setup') await router.replace('/setup');
  },
);
</script>

<template>
  <RouterView v-if="bare" />
  <AppLayout v-else>
    <RouterView />
  </AppLayout>
</template>
