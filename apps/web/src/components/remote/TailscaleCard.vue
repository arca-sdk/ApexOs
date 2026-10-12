<script setup lang="ts">
/** Tailscale: the recommended way to reach ApexOs and shared folders from your own devices. */
import { computed, ref } from 'vue';
import { ExternalLink, Waypoints } from 'lucide-vue-next';
import type { RemoteAccessStatus, TaskStarted } from '@apexos/api-types';
import { api } from '../../lib/api.ts';
import CopyField from '../account/CopyField.vue';
import ConfirmDialog from '../ConfirmDialog.vue';
import TaskProgress from '../storage/TaskProgress.vue';
import { useRemoteTask } from './remoteTask.ts';
import RemoteStateBadge from './RemoteStateBadge.vue';
import TailscaleSetupDialog from './TailscaleSetupDialog.vue';

const props = defineProps<{ status: RemoteAccessStatus }>();
const emit = defineEmits<{ changed: [] }>();

const ts = computed(() => props.status.tailscale);
const { task, error, follow } = useRemoteTask('Tailscale', () => emit('changed'));
const setupOpen = ref(false);
const offOpen = ref(false);
const offError = ref<string | null>(null);

const adminUrl = computed(() => (ts.value.controlServer ? null : 'https://login.tailscale.com/admin/machines'));

function started(start: Promise<TaskStarted>) {
  setupOpen.value = false;
  void follow(start);
}

async function turnOff() {
  offError.value = null;
  try {
    const start = api.del<TaskStarted>('/remote/tailscale');
    await start;
    offOpen.value = false;
    void follow(start);
  } catch (e) {
    offError.value = e instanceof Error ? e.message : String(e);
  }
}

const offMessage = computed(() =>
  [
    'ApexOs removes the Tailscale app from your server, together with its Tailscale identity. Your devices won’t reach the server through Tailscale anymore.',
    ts.value.routes.length ? 'Sharing your home network stops too.' : '',
    'Afterwards, remove the machine from your Tailscale admin console.',
  ]
    .filter(Boolean)
    .join(' '),
);
</script>

<template>
  <section class="card stack method" aria-labelledby="ts-h">
    <div class="row wrap" style="--gap: 10px">
      <Waypoints :size="22" class="method-icon" aria-hidden="true" />
      <h2 id="ts-h">Tailscale</h2>
      <span class="badge accent">Recommended</span>
      <span class="spacer" />
      <RemoteStateBadge :enabled="ts.enabled || ts.external" :state="ts.state" />
    </div>
    <p class="small">
      Your server joins your own private Tailscale network. Phones and laptops signed in to the same account can open ApexOs and your shared folders as
      if they were at home. Connections are encrypted end to end, and nothing is opened to the internet.
    </p>

    <TaskProgress v-if="task" :task="task" />
    <p v-if="error && !task" class="callout err" role="alert">{{ error }}</p>

    <template v-if="ts.external">
      <p class="callout">
        Tailscale is already installed on this server as the app “{{ ts.appName }}”<template v-if="ts.hostname"> (machine name {{ ts.hostname }})</template>,
        set up outside ApexOs. ApexOs leaves it alone. To manage it here instead, uninstall it on the <RouterLink to="/apps">Apps</RouterLink> page first.
      </p>
    </template>

    <template v-else-if="ts.enabled && !task">
      <p v-if="ts.state === 'missing'" class="callout warn">
        The Tailscale app was removed outside ApexOs, so remote access through Tailscale isn’t working. Turn it off here to tidy up, then set it up again
        if you like.
      </p>
      <p v-else-if="ts.state === 'crashed' || ts.state === 'stopped'" class="callout warn">
        Tailscale isn’t running. Start it on the <RouterLink to="/apps">Apps</RouterLink> page. If it keeps stopping, the auth key may have expired: turn
        Tailscale off and set it up again with a new key.
      </p>

      <div class="stack" style="--gap: 12px">
        <CopyField v-if="ts.remoteUrl" :value="ts.remoteUrl" label="ApexOs from your devices" />
        <div v-if="ts.hostname" class="small stack" style="--gap: 4px">
          <span class="field-label">Shared folders</span>
          <span>Windows: <code>{{ ts.filesAddress }}\Media</code> · Mac: <code>smb://{{ ts.hostname }}/Media</code> (use your folder’s name)</span>
        </div>
        <p class="small muted">
          <template v-if="ts.tailnetIp">
            The server’s Tailscale address is <code>{{ ts.tailnetIp }}</code><template v-if="ts.tailnetName"> ({{ ts.tailnetName }})</template>. Use it
            instead of the name if your devices don’t have MagicDNS turned on.
          </template>
          <template v-else>
            The name works on devices with MagicDNS turned on (the default). The server’s 100.x.y.z address is listed in your
            <a v-if="adminUrl" :href="adminUrl" target="_blank" rel="noopener noreferrer">Tailscale admin console <ExternalLink :size="12" aria-hidden="true" /></a>
            <template v-else>Headscale node list</template> under the name {{ ts.hostname }}.
          </template>
        </p>
      </div>

      <div v-if="ts.routes.length" class="callout stack" style="--gap: 6px">
        <strong>Approve your home network</strong>
        <span class="small">
          <template v-if="adminUrl">
            In the <a :href="adminUrl" target="_blank" rel="noopener noreferrer">Tailscale admin console</a>, open the machine {{ ts.hostname }}, choose
            <em>Edit route settings</em> and turn on <code>{{ ts.routes.join(', ') }}</code>.
          </template>
          <template v-else>On your Headscale server, enable the route <code>{{ ts.routes.join(', ') }}</code> for {{ ts.hostname }}.</template>
          Until then, use the addresses above. Linux devices also need <code>tailscale set --accept-routes</code>.
        </span>
      </div>

      <p class="small muted">
        Tip: turn off <em>key expiry</em> for this machine in the admin console, otherwise it has to be signed in again after a few months.
      </p>

      <div><button class="btn danger" @click="(offError = null), (offOpen = true)">Turn off</button></div>
    </template>

    <template v-else-if="!task">
      <div class="row wrap" style="--gap: 10px">
        <button class="btn primary" :disabled="!status.appsReady" @click="setupOpen = true">Set up Tailscale</button>
        <span class="small muted">You need a free Tailscale account.</span>
      </div>
    </template>
  </section>

  <TailscaleSetupDialog v-if="setupOpen" :status="status" @close="setupOpen = false" @started="started" />

  <ConfirmDialog
    v-if="offOpen"
    title="Turn off Tailscale?"
    :message="offMessage"
    action-label="Turn off Tailscale"
    danger
    :error="offError"
    @confirm="turnOff"
    @close="offOpen = false"
  >
    <p v-if="status.connectedVia === 'tailscale'" class="callout warn">You’re connected through Tailscale right now, so this page will stop responding.</p>
  </ConfirmDialog>
</template>
