<script setup lang="ts">
/** Sign-in: username and password, then (when two-factor sign-in is on) a code from the authenticator app. */
import { nextTick, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { LoginResponse, LoginVerifyResponse } from '@apexos/api-types';
import CodeInput from '../components/account/CodeInput.vue';
import OnboardingFrame from '../components/OnboardingFrame.vue';
import { ApiError, api, refreshStatus } from '../lib/api.ts';

const router = useRouter();
const username = ref('');
const password = ref('');
const error = ref('');
const busy = ref(false);

const step = ref<'password' | 'code' | 'recovery-used'>('password');
const challenge = ref('');
const code = ref('');
const recovery = ref(false);
const codesLeft = ref(0);
const codeForm = ref<HTMLFormElement | null>(null);

function message(e: unknown): string {
  return e instanceof ApiError ? e.message : String(e);
}

async function focusCode() {
  await nextTick();
  codeForm.value?.querySelector<HTMLInputElement>('input')?.focus();
}

async function finish() {
  await refreshStatus();
  router.replace('/');
}

async function submit() {
  error.value = '';
  busy.value = true;
  try {
    const res = await api.post<LoginResponse>('/auth/login', { username: username.value, password: password.value });
    if (res.ok) return await finish();
    challenge.value = res.challenge;
    code.value = '';
    recovery.value = false;
    step.value = 'code';
    void focusCode();
  } catch (e) {
    error.value = message(e);
  } finally {
    busy.value = false;
  }
}

async function verify() {
  error.value = '';
  busy.value = true;
  try {
    const res = await api.post<LoginVerifyResponse>('/auth/login/verify', { challenge: challenge.value, code: code.value });
    password.value = '';
    if (res.recoveryCodeUsed) {
      codesLeft.value = res.recoveryCodesLeft;
      step.value = 'recovery-used';
      return;
    }
    await finish();
  } catch (e) {
    error.value = message(e);
    if (e instanceof ApiError && e.code === 'CHALLENGE_EXPIRED') {
      step.value = 'password';
      password.value = '';
    } else {
      code.value = '';
      void focusCode();
    }
  } finally {
    busy.value = false;
  }
}

function toggleRecovery() {
  recovery.value = !recovery.value;
  code.value = '';
  error.value = '';
  void focusCode();
}

function back() {
  step.value = 'password';
  error.value = '';
  password.value = '';
}
</script>

<template>
  <OnboardingFrame v-if="step === 'password'" title="Sign in" subtitle="Manage your home server.">
    <form class="stack" @submit.prevent="submit">
      <div class="field">
        <label for="u">Username</label>
        <input id="u" v-model="username" type="text" autocomplete="username" required autofocus />
      </div>
      <div class="field">
        <label for="p">Password</label>
        <input id="p" v-model="password" type="password" autocomplete="current-password" required />
      </div>
      <p v-if="error" class="callout err" role="alert">{{ error }}</p>
      <button class="btn primary" :disabled="busy"><span v-if="busy" class="spin" />Sign in</button>
    </form>
  </OnboardingFrame>

  <OnboardingFrame
    v-else-if="step === 'code'"
    title="Two-factor sign-in"
    :subtitle="recovery ? 'Enter one of the recovery codes you saved.' : 'Enter the 6-digit code from your authenticator app.'"
  >
    <form ref="codeForm" class="stack" @submit.prevent="verify">
      <div class="field">
        <label for="otp">{{ recovery ? 'Recovery code' : 'Code' }}</label>
        <CodeInput id="otp" v-model="code" :recovery="recovery" :invalid="Boolean(error)" />
      </div>
      <p v-if="error" class="callout err" role="alert">{{ error }}</p>
      <button class="btn primary" :disabled="busy"><span v-if="busy" class="spin" />Verify</button>
      <div class="row wrap alt-actions" style="--gap: 4px">
        <button type="button" class="btn ghost small" @click="toggleRecovery">
          {{ recovery ? 'Use my authenticator app' : 'Use a recovery code' }}
        </button>
        <span class="spacer" />
        <button type="button" class="btn ghost small" @click="back">Back</button>
      </div>
    </form>
    <template #footer>Lost your phone and your recovery codes? See “Locked out” in the ApexOs README.</template>
  </OnboardingFrame>

  <OnboardingFrame v-else title="You used a recovery code" subtitle="That code won’t work again.">
    <div class="stack">
      <p :class="codesLeft <= 3 ? 'callout warn' : ''">
        You have <strong>{{ codesLeft }}</strong> recovery code{{ codesLeft === 1 ? '' : 's' }} left. If you lost access to your authenticator app,
        set it up again in Settings → Your account: turn two-factor sign-in off and on, or make new recovery codes.
      </p>
      <button class="btn primary" @click="finish">Continue</button>
    </div>
  </OnboardingFrame>
</template>

<style scoped>
.alt-actions .btn {
  color: var(--accent-strong);
}
</style>
