<script setup lang="ts">
/** Cloudflare Tunnel: publishes only the ApexOs web page through a hostname in the user's Cloudflare account. */
import { computed, ref } from 'vue';
import { Cloud, ExternalLink } from 'lucide-vue-next';
import type { RemoteAccessStatus, TaskStarted } from '@apexos/api-types';
import { api } from '../../lib/api.ts';
import CopyField from '../account/CopyField.vue';
import ConfirmDialog from '../ConfirmDialog.vue';
import TaskProgress from '../storage/TaskProgress.vue';
import CloudflareSetupDialog from './CloudflareSetupDialog.vue';
import { useRemoteTask } from './remoteTask.ts';
import RemoteStateBadge from './RemoteStateBadge.vue';

const props = defineProps<{ status: RemoteAccessStatus }>();
const emit = defineEmits<{ changed: [] }>();

const cf = computed(() => props.status.cloudflare);
const cookiesOk = computed(() => props.status.checklist.find((c) => c.id === 'secure-cookies')?.ok === true);
const { task, error, follow } = useRemoteTask('Cloudflare Tunnel', () => emit('changed'));
const setupOpen = ref(false);
const offOpen = ref(false);
const offError = ref<string | null>(null);

function started(start: Promise<TaskStarted>) {
  setupOpen.value = false;
  void follow(start);
}

async function turnOff() {
  offError.value = null;
  try {
    const start = api.del<TaskStarted>('/remote/cloudflare');
    await start;
    offOpen.value = false;
    void follow(start);
  } catch (e) {
    offError.value = e instanceof Error ? e.message : String(e);
  }
}
</script>

<template>
  <section class="card stack method" aria-labelledby="cf-h">
    <div class="row wrap" style="--gap: 10px">
      <Cloud :size="22" class="method-icon" aria-hidden="true" />
      <h2 id="cf-h">Cloudflare Tunnel</h2>
      <span class="badge info">Web page only</span>
      <span class="spacer" />
      <RemoteStateBadge :enabled="cf.enabled || cf.external" :state="cf.state" />
    </div>
    <p class="small">
      Opens the ApexOs web page at an address on your own domain, such as nas.example.com, through your Cloudflare account. Works from any browser
      without installing anything. Shared folders and other apps are not published.
    </p>

    <TaskProgress v-if="task" :task="task" />
    <p v-if="error && !task" class="callout err" role="alert">{{ error }}</p>

    <p v-if="cf.external" class="callout">
      A Cloudflare tunnel app (“{{ cf.appName }}”) is already installed on this server, set up outside ApexOs. ApexOs leaves it alone. To manage it here
      instead, uninstall it on the <RouterLink to="/apps">Apps</RouterLink> page first.
    </p>

    <template v-else-if="cf.enabled && !task">
      <p v-if="cf.state === 'missing'" class="callout warn">The tunnel app was removed outside ApexOs. Turn it off here to tidy up.</p>
      <p v-else-if="cf.state === 'crashed' || cf.state === 'stopped'" class="callout warn">
        The tunnel isn’t running. Start it on the <RouterLink to="/apps">Apps</RouterLink> page, and check the tunnel’s status in Cloudflare.
      </p>
      <p v-if="cf.publicHostname" class="small">
        Open ApexOs at
        <a :href="`https://${cf.publicHostname}`" target="_blank" rel="noopener noreferrer">https://{{ cf.publicHostname }} <ExternalLink :size="12" aria-hidden="true" /></a>
      </p>
      <CopyField v-if="cf.serviceUrl" :value="cf.serviceUrl.replace(/^https?:\/\//, '')" label="Service URL in Cloudflare (type HTTP)" />
      <p v-if="!cookiesOk" class="callout warn small">
        Start ApexOs with <code>APEXOS_SECURE_COOKIES=1</code> so your sign-in cookie is never sent unencrypted, and use the HTTPS address, also at home.
      </p>
      <p class="small muted">Tip: a Cloudflare Access policy in front of the hostname keeps everyone but you away from the sign-in page.</p>
      <div><button class="btn danger" @click="(offError = null), (offOpen = true)">Turn off</button></div>
    </template>

    <template v-else-if="!task">
      <p v-if="!status.twoFactorEnabled" class="callout warn small">
        This puts your sign-in page on the internet, so <RouterLink to="/settings?section=account">two-factor sign-in</RouterLink> has to be on first.
      </p>
      <div class="row wrap" style="--gap: 10px">
        <button class="btn" :disabled="!status.appsReady || !status.twoFactorEnabled" @click="setupOpen = true">Set up Cloudflare Tunnel</button>
        <span class="small muted">You need a Cloudflare account and a domain that uses it.</span>
      </div>
    </template>
  </section>

  <CloudflareSetupDialog v-if="setupOpen" :status="status" @close="setupOpen = false" @started="started" />

  <ConfirmDialog
    v-if="offOpen"
    title="Turn off Cloudflare Tunnel?"
    message="ApexOs removes the tunnel app from your server. Your public address stops working; you can delete the tunnel in Cloudflare afterwards."
    action-label="Turn off tunnel"
    danger
    :error="offError"
    @confirm="turnOff"
    @close="offOpen = false"
  >
    <p v-if="status.connectedVia === 'cloudflare'" class="callout warn">You’re connected through the tunnel right now, so this page will stop responding.</p>
  </ConfirmDialog>
</template>
