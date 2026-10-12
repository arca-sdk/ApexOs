<script setup lang="ts">
/** Set up Tailscale with an auth key from the user's own Tailscale (or Headscale) account. */
import { computed, reactive, ref } from 'vue';
import { ExternalLink } from 'lucide-vue-next';
import type { RemoteAccessStatus, TailscaleEnableRequest, TaskStarted } from '@apexos/api-types';
import { ApiError, api } from '../../lib/api.ts';
import Modal from '../Modal.vue';

const props = defineProps<{ status: RemoteAccessStatus }>();
const emit = defineEmits<{ close: []; started: [start: Promise<TaskStarted>] }>();

const form = reactive({
  authKey: '',
  hostname: props.status.tailscale.suggestedHostname,
  shareHomeNetwork: false,
  controlServer: '',
  acceptWithoutTwoFactor: false,
});
const fields = ref<Record<string, string>>({});
const error = ref<string | null>(null);
const busy = ref(false);
/** Field problems shown next to their inputs; anything else goes in the message at the bottom. */
const fieldShown = computed(() => ['authKey', 'hostname', 'controlServer'].some((k) => fields.value[k]));

async function submit() {
  error.value = null;
  fields.value = {};
  busy.value = true;
  const body: TailscaleEnableRequest = {
    authKey: form.authKey.trim(),
    hostname: form.hostname.trim().toLowerCase(),
    shareHomeNetwork: form.shareHomeNetwork,
    controlServer: form.controlServer.trim() || null,
    acceptWithoutTwoFactor: form.acceptWithoutTwoFactor,
  };
  try {
    // Start the task here so input problems show in this dialog; the card follows the task.
    const start = api.post<TaskStarted>('/remote/tailscale', body);
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
  <Modal title="Set up Tailscale" wide @close="emit('close')">
    <form id="ts-setup" class="stack" style="--gap: 18px" @submit.prevent="submit">
      <ol class="small how">
        <li>
          Sign in to your Tailscale account (free for personal use) and open
          <a href="https://login.tailscale.com/admin/settings/keys" target="_blank" rel="noopener noreferrer">Settings → Keys <ExternalLink :size="12" aria-hidden="true" /></a>.
        </li>
        <li>Generate an auth key. Leave <em>Reusable</em> and <em>Ephemeral</em> off. If your tailnet asks you to approve new devices, turn on <em>Pre-approved</em>.</li>
        <li>Paste the key below. Install Tailscale on your phone and laptop and sign in with the same account.</li>
      </ol>

      <div class="field">
        <label for="ts-key">Auth key</label>
        <input
          id="ts-key"
          v-model="form.authKey"
          type="password"
          autocomplete="off"
          spellcheck="false"
          placeholder="tskey-auth-…"
          required
          :aria-invalid="Boolean(fields.authKey) || undefined"
          aria-describedby="ts-key-hint"
        />
        <span v-if="fields.authKey" class="error-text">{{ fields.authKey }}</span>
        <span id="ts-key-hint" class="hint">ApexOs hands the key to TrueNAS for the Tailscale app and doesn’t keep a copy. It’s only used for the first sign-in.</span>
      </div>

      <div class="field">
        <label for="ts-host">Machine name</label>
        <input
          id="ts-host"
          v-model="form.hostname"
          type="text"
          autocomplete="off"
          spellcheck="false"
          maxlength="63"
          required
          :aria-invalid="Boolean(fields.hostname) || undefined"
          aria-describedby="ts-host-hint"
          style="max-width: 280px"
        />
        <span v-if="fields.hostname" class="error-text">{{ fields.hostname }}</span>
        <span id="ts-host-hint" class="hint">How your server shows up in Tailscale. You’ll open ApexOs at http://{{ form.hostname || 'name' }}:{{ status.port }}.</span>
      </div>

      <label class="option">
        <input v-model="form.shareHomeNetwork" type="checkbox" :disabled="!status.tailscale.homeNetwork" />
        <span class="stack" style="--gap: 2px">
          <strong>Share my home network</strong>
          <span v-if="status.tailscale.homeNetwork" class="small muted">
            Also lets your devices reach other things at home, like the router or a printer, by their usual addresses ({{ status.tailscale.homeNetwork }}).
            You’ll need to approve this in the Tailscale admin console. Not needed for ApexOs or shared folders.
          </span>
          <span v-else class="small muted">ApexOs couldn’t work out your home network’s address range, so this isn’t available.</span>
        </span>
      </label>

      <details class="advanced">
        <summary>Use my own Headscale server</summary>
        <div class="field" style="margin-top: 10px">
          <label for="ts-control">Headscale address</label>
          <input
            id="ts-control"
            v-model="form.controlServer"
            type="url"
            autocomplete="off"
            placeholder="https://headscale.example.com"
            :aria-invalid="Boolean(fields.controlServer) || undefined"
          />
          <span v-if="fields.controlServer" class="error-text">{{ fields.controlServer }}</span>
          <span class="hint">Headscale is a coordination server you run yourself instead of Tailscale’s. Use a pre-auth key from it as the auth key.</span>
        </div>
      </details>

      <div v-if="!status.twoFactorEnabled" class="callout warn stack" style="--gap: 10px">
        <p>
          <strong>Two-factor sign-in is off.</strong> Anyone on your tailnet who learns your password could manage this server.
          <RouterLink to="/settings?section=account">Turn on two-factor sign-in</RouterLink> first.
        </p>
        <label class="row consent" style="--gap: 10px">
          <input v-model="form.acceptWithoutTwoFactor" type="checkbox" />
          <span>Continue without two-factor sign-in (not recommended)</span>
        </label>
      </div>

      <p v-if="error && !fieldShown" class="callout err" role="alert">{{ error }}</p>
    </form>
    <template #footer>
      <button class="btn" type="button" @click="emit('close')">Cancel</button>
      <button class="btn primary" type="submit" form="ts-setup" :disabled="busy || (!status.twoFactorEnabled && !form.acceptWithoutTwoFactor)">
        <span v-if="busy" class="spin" />Turn on Tailscale
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.how {
  margin: 0;
  padding-left: 1.3em;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.option {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.option input,
.consent input {
  margin-top: 3px;
  flex: none;
}
.consent {
  align-items: flex-start;
  cursor: pointer;
}
.advanced summary {
  cursor: pointer;
  font-weight: 550;
  font-size: 0.92rem;
}
</style>
