<script setup lang="ts">
/**
 * Remote access: reach the server from outside the home through services the user owns (Tailscale,
 * Cloudflare Tunnel) or their own VPN / reverse proxy. ApexOs runs no relay of its own.
 */
import { onMounted, ref } from 'vue';
import type { RemoteAccessStatus } from '@apexos/api-types';
import PageState from '../components/PageState.vue';
import CloudflareCard from '../components/remote/CloudflareCard.vue';
import OwnVpnCard from '../components/remote/OwnVpnCard.vue';
import SecurityChecklist from '../components/remote/SecurityChecklist.vue';
import TailscaleCard from '../components/remote/TailscaleCard.vue';
import { api } from '../lib/api.ts';
import { onServerChange } from '../lib/events.ts';

const status = ref<RemoteAccessStatus | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);

async function load() {
  error.value = null;
  try {
    status.value = await api.get<RemoteAccessStatus>('/remote');
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}
function retry() {
  loading.value = true;
  load();
}
onMounted(load);
onServerChange(['apps', 'system'], load);

const via: Record<RemoteAccessStatus['connectedVia'], string | null> = {
  tailscale: 'You’re connected through Tailscale right now.',
  cloudflare: 'You’re connected through Cloudflare Tunnel right now.',
  proxy: 'You’re connected through a proxy right now.',
  direct: null,
};
</script>

<template>
  <div class="page-header">
    <div>
      <h1>Remote access</h1>
      <p class="subtitle">Reach your server when you’re away from home, through accounts you own. ApexOs runs no cloud service and never sees your traffic.</p>
    </div>
  </div>

  <PageState :loading="loading" :error="error" @retry="retry">
    <div v-if="status" class="remote-layout">
      <div class="stack side">
        <SecurityChecklist :items="status.checklist" />
        <p v-if="via[status.connectedVia]" class="callout small" role="status">{{ via[status.connectedVia] }}</p>
      </div>
      <div class="stack main">
        <p v-if="status.appsMessage" class="callout warn" role="status">{{ status.appsMessage }}</p>
        <TailscaleCard :status="status" @changed="load" />
        <CloudflareCard :status="status" @changed="load" />
        <OwnVpnCard :status="status" />
      </div>
    </div>
  </PageState>
</template>

<style scoped>
.remote-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  grid-template-areas: 'main side';
  gap: 20px;
  align-items: start;
}
.main {
  grid-area: main;
  min-width: 0;
}
.side {
  grid-area: side;
  position: sticky;
  top: 24px;
}
.remote-layout :deep(.method-icon) {
  color: var(--accent);
  flex: none;
}
@media (max-width: 1000px) {
  .remote-layout {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas: 'side' 'main';
  }
  .side {
    position: static;
  }
}
</style>
