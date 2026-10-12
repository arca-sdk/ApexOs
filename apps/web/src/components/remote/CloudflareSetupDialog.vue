<script setup lang="ts">
/** Set up Cloudflare Tunnel with a tunnel token from the user's own Cloudflare account. */
import { computed, reactive, ref } from 'vue';
import { ExternalLink } from 'lucide-vue-next';
import type { CloudflareEnableRequest, RemoteAccessStatus, TaskStarted } from '@apexos/api-types';
import { ApiError, api } from '../../lib/api.ts';
import CopyField from '../account/CopyField.vue';
import Modal from '../Modal.vue';

const props = defineProps<{ status: RemoteAccessStatus }>();
const emit = defineEmits<{ close: []; started: [start: Promise<TaskStarted>] }>();

const form = reactive({ token: '', publicHostname: '' });
const fields = ref<Record<string, string>>({});
const error = ref<string | null>(null);
const busy = ref(false);
const fieldShown = computed(() => ['token', 'publicHostname'].some((k) => fields.value[k]));
/** Cloudflare asks for the service type (HTTP) and the address without the scheme. */
const serviceAddress = computed(() => props.status.cloudflare.serviceUrl?.replace(/^https?:\/\//, '') ?? null);

async function submit() {
  error.value = null;
  fields.value = {};
  busy.value = true;
  const body: CloudflareEnableRequest = { token: form.token, publicHostname: form.publicHostname.trim() || null };
  try {
    const start = api.post<TaskStarted>('/remote/cloudflare', body);
    await start;
    emit('started', start);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    if (e instanceof ApiError) fields.value = e.fields;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Modal title="Set up Cloudflare Tunnel" wide @close="emit('close')">
    <form id="cf-setup" class="stack" style="--gap: 18px" @submit.prevent="submit">
      <ol class="small how">
        <li>
          In the
          <a href="https://one.dash.cloudflare.com/" target="_blank" rel="noopener noreferrer">Cloudflare Zero Trust dashboard <ExternalLink :size="12" aria-hidden="true" /></a>
          open <em>Networks → Tunnels</em> and create a tunnel of type <em>Cloudflared</em>. Your domain must already use Cloudflare.
        </li>
        <li>Copy the token from the install command Cloudflare shows (the long text starting with “eyJ”). Pasting the whole command works too.</li>
        <li>
          Add a <em>public hostname</em> to the tunnel, for example <code>nas</code> on your domain. Set the service type to <strong>HTTP</strong> and the URL to
          the address below.
        </li>
      </ol>

      <CopyField v-if="serviceAddress" :value="serviceAddress" label="Service URL for Cloudflare (type HTTP)" />

      <div class="field">
        <label for="cf-token">Tunnel token</label>
        <input
          id="cf-token"
          v-model="form.token"
          type="password"
          autocomplete="off"
          spellcheck="false"
          placeholder="eyJ…"
          required
          :aria-invalid="Boolean(fields.token) || undefined"
          aria-describedby="cf-token-hint"
        />
        <span v-if="fields.token" class="error-text">{{ fields.token }}</span>
        <span id="cf-token-hint" class="hint">ApexOs hands the token to TrueNAS for the tunnel app and doesn’t keep a copy.</span>
      </div>

      <div class="field">
        <label for="cf-host">Public hostname <span class="muted">(optional)</span></label>
        <input
          id="cf-host"
          v-model="form.publicHostname"
          type="text"
          inputmode="url"
          autocomplete="off"
          spellcheck="false"
          placeholder="nas.example.com"
          :aria-invalid="Boolean(fields.publicHostname) || undefined"
          style="max-width: 320px"
        />
        <span v-if="fields.publicHostname" class="error-text">{{ fields.publicHostname }}</span>
        <span class="hint">The address you chose in Cloudflare, so ApexOs can link to it.</span>
      </div>

      <div class="callout warn small stack" style="--gap: 6px">
        <strong>Only the ApexOs web page is published</strong>
        <span>
          Shared folders and other apps stay private: file sharing doesn’t work through the tunnel. Cloudflare also limits uploads to 100 MB per request on its
          free plan.
        </span>
      </div>

      <div class="small stack" style="--gap: 6px">
        <strong>Recommended</strong>
        <ul class="recs">
          <li>Start ApexOs with <code>APEXOS_SECURE_COOKIES=1</code> so your sign-in cookie never travels unencrypted. Then sign in through the HTTPS address, also at home.</li>
          <li>Turn on <em>Always Use HTTPS</em> for your domain in Cloudflare.</li>
          <li>Add a Cloudflare Access policy for the hostname so only your email address can even reach the sign-in page.</li>
        </ul>
      </div>

      <p v-if="error && !fieldShown" class="callout err" role="alert">{{ error }}</p>
    </form>
    <template #footer>
      <button class="btn" type="button" @click="emit('close')">Cancel</button>
      <button class="btn primary" type="submit" form="cf-setup" :disabled="busy"><span v-if="busy" class="spin" />Turn on Cloudflare Tunnel</button>
    </template>
  </Modal>
</template>

<style scoped>
.how,
.recs {
  margin: 0;
  padding-left: 1.3em;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
</style>
