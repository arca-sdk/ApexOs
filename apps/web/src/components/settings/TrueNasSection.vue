<script setup lang="ts">
/** TrueNAS connection status (existing behaviour) and a link to the TrueNAS web UI. */
import { onMounted, ref } from 'vue';
import { ExternalLink } from 'lucide-vue-next';
import PageState from '../PageState.vue';
import { api, session } from '../../lib/api.ts';
import { onServerChange } from '../../lib/events.ts';

interface SettingsResponse {
  serverName: string;
  truenas: { url: string | null; connected: boolean; version: string | null };
}

const settings = ref<SettingsResponse | null>(null);
const uiUrl = ref<string | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);

async function load() {
  error.value = null;
  try {
    const [s, ui] = await Promise.all([
      api.get<SettingsResponse>('/settings'),
      api.get<{ url: string | null }>('/system/truenas-ui').catch(() => ({ url: null })),
    ]);
    settings.value = s;
    uiUrl.value = ui.url;
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
onServerChange(['truenas-connected', 'truenas-disconnected', 'system'], load);
</script>

<template>
  <div class="stack" style="--gap: 20px">
    <section class="card stack" aria-labelledby="tn-h">
      <h2 id="tn-h">TrueNAS connection</h2>
      <PageState :loading="loading" :error="error" @retry="retry">
        <template v-if="settings">
          <table class="table">
            <tbody>
              <tr>
                <td class="muted">Status</td>
                <td>
                  <span class="badge" :class="settings.truenas.connected ? 'ok' : 'err'">{{ settings.truenas.connected ? 'Connected' : 'Disconnected' }}</span>
                </td>
              </tr>
              <tr>
                <td class="muted">Address</td>
                <td class="mono small addr">{{ settings.truenas.url ?? '—' }}</td>
              </tr>
              <tr>
                <td class="muted">Version</td>
                <td>{{ settings.truenas.version?.replace(/^TrueNAS-/i, '') ?? '—' }}</td>
              </tr>
            </tbody>
          </table>
          <div v-if="!session.demo"><RouterLink to="/connect" class="btn small">Change connection</RouterLink></div>
        </template>
      </PageState>
    </section>

    <section v-if="uiUrl" class="card stack" aria-labelledby="tn-ui-h">
      <h2 id="tn-ui-h">TrueNAS UI</h2>
      <p class="muted small">
        ApexOs runs on top of TrueNAS. For settings ApexOs doesn’t cover, you can use the full TrueNAS interface. It only works from your home network. Sign in
        with your TrueNAS admin account; your browser may warn about the certificate the first time, which is expected for a home server.
      </p>
      <p class="small muted">Be careful there: changes to folders, shares or users made in TrueNAS can confuse ApexOs.</p>
      <div>
        <a :href="uiUrl" target="_blank" rel="noopener" class="btn small">Open the TrueNAS UI <ExternalLink :size="14" /></a>
      </div>
    </section>
  </div>
</template>

<style scoped>
.addr {
  overflow-wrap: anywhere;
}
</style>
