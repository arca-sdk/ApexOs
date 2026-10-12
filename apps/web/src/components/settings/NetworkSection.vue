<script setup lang="ts">
/** Read-only view of the server's network setup. */
import { onMounted, ref } from 'vue';
import { Cable } from 'lucide-vue-next';
import type { NetworkInfo } from '@hearth/api-types';
import PageState from '../PageState.vue';
import { api } from '../../lib/api.ts';
import { onServerChange } from '../../lib/events.ts';

const info = ref<NetworkInfo | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);

async function load() {
  error.value = null;
  try {
    info.value = await api.get<NetworkInfo>('/system/network');
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
onServerChange(['system'], load);

function speed(mbps: number | null): string {
  if (!mbps) return '';
  return mbps >= 1000 ? `${mbps / 1000} Gbit/s` : `${mbps} Mbit/s`;
}
</script>

<template>
  <section class="card stack" aria-labelledby="ns-h">
    <h2 id="ns-h">Network</h2>
    <p class="muted small">How your server is connected. Changing these settings isn’t available in Hearth yet; you can do it in the TrueNAS UI.</p>
    <PageState :loading="loading" :error="error" @retry="retry">
      <template v-if="info">
        <dl class="facts">
          <dt>Hostname</dt>
          <dd class="mono">{{ info.hostname }}</dd>
          <dt>Gateway</dt>
          <dd class="mono">{{ info.gateway.length ? info.gateway.join(', ') : 'None' }}</dd>
          <dt>DNS servers</dt>
          <dd class="mono">{{ info.nameservers.length ? info.nameservers.join(', ') : 'None' }}</dd>
        </dl>

        <h3>Network ports</h3>
        <p v-if="!info.interfaces.length" class="muted small">No network ports found.</p>
        <ul class="ifaces">
          <li v-for="i in info.interfaces" :key="i.name" class="card flat stack" style="--gap: 8px">
            <div class="row wrap" style="--gap: 8px">
              <Cable :size="16" class="muted" />
              <strong class="mono">{{ i.name }}</strong>
              <span class="badge" :class="i.linkUp ? 'ok' : ''">{{ i.linkUp ? 'Connected' : 'Not connected' }}</span>
              <span v-if="i.linkUp && i.speedMbps" class="small muted">{{ speed(i.speedMbps) }}</span>
            </div>
            <dl class="facts small">
              <dt>Address setup</dt>
              <dd>{{ i.dhcp ? 'Automatic (DHCP)' : 'Fixed (static)' }}</dd>
              <dt>IP addresses</dt>
              <dd class="mono">{{ i.addresses.length ? i.addresses.join(', ') : 'None' }}</dd>
              <template v-if="i.mac">
                <dt>Hardware address</dt>
                <dd class="mono">{{ i.mac }}</dd>
              </template>
              <template v-if="i.type && i.type !== 'PHYSICAL'">
                <dt>Type</dt>
                <dd>{{ i.type.toLowerCase() }}</dd>
              </template>
            </dl>
          </li>
        </ul>
        <p class="small muted">
          Tip: if you use your server a lot from other devices, ask your router to always give it the same IP address (often called a DHCP reservation).
        </p>
      </template>
    </PageState>
  </section>
</template>

<style scoped>
.facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 16px;
  margin: 0;
}
.facts dt {
  color: var(--text-muted);
}
.facts dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.ifaces {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ifaces .card {
  padding: 14px 16px;
}
@media (max-width: 480px) {
  .facts {
    grid-template-columns: 1fr;
    gap: 2px;
  }
  .facts dd {
    margin-bottom: 6px;
  }
}
</style>
