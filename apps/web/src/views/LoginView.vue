<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import OnboardingFrame from '../components/OnboardingFrame.vue';
import { ApiError, api, refreshStatus } from '../lib/api.ts';

const router = useRouter();
const username = ref('');
const password = ref('');
const error = ref('');
const busy = ref(false);

async function submit() {
  error.value = '';
  busy.value = true;
  try {
    await api.post('/auth/login', { username: username.value, password: password.value });
    await refreshStatus();
    router.replace('/');
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <OnboardingFrame title="Sign in" subtitle="Manage your home server.">
    <form class="stack" @submit.prevent="submit">
      <div class="field">
        <label for="u">Username</label>
        <input id="u" v-model="username" type="text" autocomplete="username" required autofocus />
      </div>
      <div class="field">
        <label for="p">Password</label>
        <input id="p" v-model="password" type="password" autocomplete="current-password" required />
      </div>
      <p v-if="error" class="callout err">{{ error }}</p>
      <button class="btn primary" :disabled="busy">Sign in</button>
    </form>
  </OnboardingFrame>
</template>
