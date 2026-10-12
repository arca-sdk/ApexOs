<script setup lang="ts">
/** Settings → Your account: two-factor sign-in status, new recovery codes, turning it on and off. */
import { onMounted, ref } from 'vue';
import { ShieldCheck, ShieldOff } from 'lucide-vue-next';
import type { AccountSecurity, RecoveryCodesResponse } from '@apexos/api-types';
import { ApiError, api, session } from '../../lib/api.ts';
import Modal from '../Modal.vue';
import PageState from '../PageState.vue';
import CodeInput from './CodeInput.vue';
import RecoveryCodes from './RecoveryCodes.vue';
import TwoFactorSetupDialog from './TwoFactorSetupDialog.vue';

const security = ref<AccountSecurity | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);

async function load() {
  error.value = null;
  try {
    security.value = await api.get<AccountSecurity>('/auth/security');
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

const setupOpen = ref(false);

// ---- turn off ----
const offOpen = ref(false);
const offPassword = ref('');
const offCode = ref('');
const offRecovery = ref(false);
const offError = ref<string | null>(null);
const offNeedsRemote = ref(false);
const offBusy = ref(false);
function openOff() {
  offPassword.value = offCode.value = '';
  offRecovery.value = false;
  offError.value = null;
  offNeedsRemote.value = false;
  offOpen.value = true;
}
async function turnOff() {
  offBusy.value = true;
  offError.value = null;
  try {
    await api.post('/auth/2fa/disable', { password: offPassword.value, code: offCode.value });
    offOpen.value = false;
    await load();
  } catch (e) {
    offError.value = e instanceof Error ? e.message : String(e);
    offNeedsRemote.value = e instanceof ApiError && e.code === 'REMOTE_ACCESS_ON';
  } finally {
    offBusy.value = false;
  }
}

// ---- new recovery codes ----
const regenOpen = ref(false);
const regenCode = ref('');
const regenError = ref<string | null>(null);
const regenBusy = ref(false);
const newCodes = ref<string[] | null>(null);
const newSaved = ref(false);
function openRegen() {
  regenCode.value = '';
  regenError.value = null;
  newCodes.value = null;
  newSaved.value = false;
  regenOpen.value = true;
}
async function regenerate() {
  regenBusy.value = true;
  regenError.value = null;
  try {
    newCodes.value = (await api.post<RecoveryCodesResponse>('/auth/2fa/recovery-codes', { code: regenCode.value })).recoveryCodes;
    await load();
  } catch (e) {
    regenError.value = e instanceof Error ? e.message : String(e);
  } finally {
    regenBusy.value = false;
  }
}

function since(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : '';
}
</script>

<template>
  <section class="card stack" aria-labelledby="tf-h">
    <div class="row wrap" style="--gap: 10px">
      <h2 id="tf-h">Two-factor sign-in</h2>
      <span v-if="security" class="badge" :class="security.twoFactor.enabled ? 'ok' : 'warn'">{{ security.twoFactor.enabled ? 'On' : 'Off' }}</span>
    </div>
    <PageState :loading="loading" :error="error" @retry="load">
      <div v-if="security" class="stack" style="--gap: 14px">
        <template v-if="security.twoFactor.enabled">
          <p class="row small" style="--gap: 10px; align-items: flex-start">
            <ShieldCheck :size="20" class="ok-icon" aria-hidden="true" />
            <span>
              Signing in asks for a code from your authenticator app as well as your password. On since {{ since(security.twoFactor.enabledAt) }}.
            </span>
          </p>
          <p class="small" :class="{ 'callout warn': security.twoFactor.recoveryCodesLeft <= 3 }">
            <strong>{{ security.twoFactor.recoveryCodesLeft }}</strong> of 10 recovery codes left.
            <template v-if="security.twoFactor.recoveryCodesLeft <= 3"> Make new ones so you don’t get locked out.</template>
          </p>
          <div class="row wrap" style="--gap: 8px">
            <button class="btn" @click="openRegen">New recovery codes</button>
            <button class="btn danger" @click="openOff">Turn off</button>
          </div>
        </template>
        <template v-else>
          <p class="row small" style="--gap: 10px; align-items: flex-start">
            <ShieldOff :size="20" class="warn-icon" aria-hidden="true" />
            <span>
              Ask for a code from your phone as well as your password, so a stolen or guessed password isn’t enough to get in. You need this before
              you can reach ApexOs from the internet (see <RouterLink to="/remote">Remote access</RouterLink>).
            </span>
          </p>
          <div><button class="btn primary" @click="setupOpen = true">Turn on two-factor sign-in</button></div>
        </template>
      </div>
    </PageState>
  </section>

  <TwoFactorSetupDialog v-if="setupOpen" @enabled="load" @close="setupOpen = false" />

  <Modal v-if="offOpen" title="Turn off two-factor sign-in?" @close="offOpen = false">
    <form id="tf-off" class="stack" @submit.prevent="turnOff">
      <p>Anyone who knows your password will be able to sign in. Your recovery codes stop working.</p>
      <input type="text" name="username" autocomplete="username" :value="session.username" hidden readonly />
      <div class="field">
        <label for="tf-off-pw">Your password</label>
        <input id="tf-off-pw" v-model="offPassword" type="password" autocomplete="current-password" required />
      </div>
      <div class="field">
        <label for="tf-off-code">{{ offRecovery ? 'Recovery code' : 'Code from your authenticator app' }}</label>
        <CodeInput id="tf-off-code" v-model="offCode" :recovery="offRecovery" style="max-width: 200px" />
        <button type="button" class="btn ghost small link-btn" @click="(offRecovery = !offRecovery), (offCode = '')">
          {{ offRecovery ? 'Use a code from my authenticator app' : 'Use a recovery code instead' }}
        </button>
      </div>
      <p v-if="offError" class="callout err" role="alert">
        {{ offError }}
        <RouterLink v-if="offNeedsRemote" to="/remote" @click="offOpen = false">Go to Remote access</RouterLink>
      </p>
    </form>
    <template #footer>
      <button class="btn" type="button" @click="offOpen = false">Cancel</button>
      <button class="btn danger solid" type="submit" form="tf-off" :disabled="offBusy"><span v-if="offBusy" class="spin" />Turn off</button>
    </template>
  </Modal>

  <Modal v-if="regenOpen" :title="newCodes ? 'Your new recovery codes' : 'Make new recovery codes'" @close="regenOpen = false">
    <RecoveryCodes v-if="newCodes" v-model:saved="newSaved" :codes="newCodes" />
    <form v-else id="tf-regen" class="stack" @submit.prevent="regenerate">
      <p>Your current recovery codes stop working and you get 10 new ones.</p>
      <div class="field">
        <label for="tf-regen-code">Code from your authenticator app</label>
        <CodeInput id="tf-regen-code" v-model="regenCode" style="max-width: 180px" />
      </div>
      <p v-if="regenError" class="callout err" role="alert">{{ regenError }}</p>
    </form>
    <template #footer>
      <button v-if="newCodes" class="btn primary" :disabled="!newSaved" @click="regenOpen = false">Done</button>
      <template v-else>
        <button class="btn" type="button" @click="regenOpen = false">Cancel</button>
        <button class="btn primary" type="submit" form="tf-regen" :disabled="regenBusy"><span v-if="regenBusy" class="spin" />Make new codes</button>
      </template>
    </template>
  </Modal>
</template>

<style scoped>
.ok-icon {
  color: var(--ok);
  flex: none;
}
.warn-icon {
  color: var(--warn);
  flex: none;
}
.link-btn {
  align-self: flex-start;
  padding-left: 0;
  color: var(--accent-strong);
}
</style>
