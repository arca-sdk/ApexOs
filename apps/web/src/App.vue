<script setup lang="ts">
import { computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppLayout from './components/AppLayout.vue';
import { session } from './lib/api.ts';
import { connectEvents, disconnectEvents } from './lib/events.ts';

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
</script>

<template>
  <RouterView v-if="bare" />
  <AppLayout v-else>
    <RouterView />
  </AppLayout>
</template>
