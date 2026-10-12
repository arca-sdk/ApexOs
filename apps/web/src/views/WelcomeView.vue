<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import OnboardingFrame from '../components/OnboardingFrame.vue';
import { ApiError, api, refreshStatus, session } from '../lib/api.ts';

const router = useRouter();
const username = ref('');
const password = ref('');
const confirm = ref('');
const error = ref('');
const busy = ref(false);

async function submit() {
  error.value = '';
  if (password.value.length < 8) return (error.value = 'Use at least 8 characters for your password.');
  if (password.value !== confirm.value) return (error.value = 'The passwords do not match.');
  busy.value = true;
  try {
    await api.post('/auth/setup', { username: username.value, password: password.value });
    await refreshStatus();
    router.replace(!session.truenasConnected ? '/connect' : session.setupComplete ? '/' : '/setup');
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <OnboardingFrame title="Welcome to Hearth" subtitle="Create the account you'll use to manage your home server.">
    <form class="stack" @submit.prevent="submit">
      <div class="field">
        <label for="u">Username</label>
        <input id="u" v-model="username" type="text" autocomplete="username" placeholder="admin" required autofocus />
      </div>
      <div class="field">
        <label for="p">Password</label>
        <input id="p" v-model="password" type="password" autocomplete="new-password" required />
      </div>
      <div class="field">
        <label for="c">Confirm password</label>
        <input id="c" v-model="confirm" type="password" autocomplete="new-password" required />
      </div>
      <p v-if="error" class="callout err">{{ error }}</p>
      <button class="btn primary" :disabled="busy">Create account</button>
    </form>
    <template #footer>Free and open-source software, licensed under the GNU GPL v3.</template>
  </OnboardingFrame>
</template>
