<script setup lang="ts">
/**
 * Turning on two-factor sign-in: scan the QR code (or type the key), confirm one code, then save the
 * recovery codes. Nothing changes on the server until the code is confirmed.
 */
import { computed, onMounted, ref } from 'vue';
import { Smartphone } from 'lucide-vue-next';
import type { RecoveryCodesResponse, TwoFactorSetup } from '@apexos/api-types';
import { ApiError, api } from '../../lib/api.ts';
import Modal from '../Modal.vue';
import QrCode from '../QrCode.vue';
import CodeInput from './CodeInput.vue';
import CopyField from './CopyField.vue';
import RecoveryCodes from './RecoveryCodes.vue';

const emit = defineEmits<{ close: []; enabled: [] }>();

const setup = ref<TwoFactorSetup | null>(null);
const loadError = ref<string | null>(null);
const code = ref('');
const error = ref<string | null>(null);
const busy = ref(false);
const codes = ref<string[] | null>(null);
const saved = ref(false);

/** The key in groups of four, easier to type into an app by hand. */
const groupedSecret = computed(() => setup.value?.secret.match(/.{1,4}/g)?.join(' ') ?? '');

async function start() {
  loadError.value = null;
  try {
    setup.value = await api.post<TwoFactorSetup>('/auth/2fa/setup');
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e);
  }
}
onMounted(start);

async function confirm() {
  error.value = null;
  busy.value = true;
  try {
    const res = await api.post<RecoveryCodesResponse>('/auth/2fa/enable', { code: code.value });
    codes.value = res.recoveryCodes;
    emit('enabled');
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    if (e instanceof ApiError && e.code === 'SETUP_EXPIRED') {
      code.value = '';
      await start();
    }
  } finally {
    busy.value = false;
  }
}

function close() {
  // An unfinished setup is thrown away so no unused secret stays on the server.
  if (!codes.value) void api.del('/auth/2fa/setup').catch(() => undefined);
  emit('close');
}
</script>

<template>
  <Modal :title="codes ? 'Save your recovery codes' : 'Turn on two-factor sign-in'" wide @close="close">
    <template v-if="codes">
      <p class="callout ok" role="status">Two-factor sign-in is on. Other browsers that were signed in to ApexOs have been signed out.</p>
      <RecoveryCodes v-model:saved="saved" :codes="codes" />
    </template>

    <template v-else-if="loadError">
      <p class="callout err" role="alert">{{ loadError }}</p>
    </template>

    <div v-else-if="!setup" class="row muted"><span class="spin" /> Preparing…</div>

    <form v-else id="tf-setup" class="stack" style="--gap: 20px" @submit.prevent="confirm">
      <ol class="setup-steps">
        <li>
          <strong>Open an authenticator app on your phone.</strong>
          <span class="small muted">
            Any app that shows 6-digit sign-in codes works, for example Aegis, 2FAS, Ente Auth, Google Authenticator, Microsoft Authenticator,
            1Password or Bitwarden.
          </span>
        </li>
        <li>
          <strong>Add ApexOs to it by scanning this code.</strong>
          <div class="scan">
            <QrCode :size="setup.qr.size" :path="setup.qr.path" :label="`QR code to add ${setup.account} to an authenticator app`" />
            <div class="stack" style="--gap: 10px; min-width: 0">
              <p class="small muted">Can’t scan it? Choose to enter a setup key in the app and type this key (time-based):</p>
              <CopyField :value="groupedSecret" label="Setup key" secret />
              <a class="btn small open-app" :href="setup.otpauthUri"><Smartphone :size="16" aria-hidden="true" /> On this phone? Open in authenticator app</a>
            </div>
          </div>
        </li>
        <li>
          <label for="tf-code"><strong>Enter the 6-digit code the app shows for ApexOs.</strong></label>
          <CodeInput id="tf-code" v-model="code" :invalid="Boolean(error)" describedby="tf-code-help" style="max-width: 180px" />
          <span id="tf-code-help" class="small muted">The code changes every 30 seconds. If it’s refused, check that your phone sets its clock automatically.</span>
        </li>
      </ol>
      <p v-if="error" class="callout err" role="alert">{{ error }}</p>
    </form>

    <template #footer>
      <template v-if="codes">
        <button class="btn primary" :disabled="!saved" @click="emit('close')">Done</button>
      </template>
      <template v-else>
        <button class="btn" type="button" @click="close">Cancel</button>
        <button class="btn primary" type="submit" form="tf-setup" :disabled="!setup || busy"><span v-if="busy" class="spin" />Turn on</button>
      </template>
    </template>
  </Modal>
</template>

<style scoped>
.setup-steps {
  margin: 0;
  padding-left: 1.3em;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.setup-steps li {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.setup-steps li::marker {
  font-weight: 650;
}
.scan {
  display: grid;
  grid-template-columns: minmax(0, 200px) minmax(0, 1fr);
  gap: 18px;
  align-items: start;
}
.open-app {
  align-self: flex-start;
  white-space: normal;
  text-align: left;
}
@media (max-width: 560px) {
  .scan {
    grid-template-columns: 1fr;
    justify-items: start;
  }
}
</style>
