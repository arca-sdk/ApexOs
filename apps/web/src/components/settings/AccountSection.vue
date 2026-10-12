<script setup lang="ts">
/** The ApexOs sign-in account (existing behaviour: change password). */
import { ref } from 'vue';
import { ApiError, api, session } from '../../lib/api.ts';

const current = ref('');
const next = ref('');
const confirm = ref('');
const pwMsg = ref('');
const pwErr = ref('');
const busy = ref(false);

async function changePassword() {
  pwMsg.value = pwErr.value = '';
  if (next.value !== confirm.value) return (pwErr.value = 'The new passwords do not match.');
  busy.value = true;
  try {
    await api.put('/settings/password', { current: current.value, next: next.value });
    current.value = next.value = confirm.value = '';
    pwMsg.value = 'Password changed.';
  } catch (e) {
    pwErr.value = e instanceof ApiError ? (e.fields.next ?? e.message) : String(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="card stack" aria-labelledby="ac-h">
    <h2 id="ac-h">Your account</h2>
    <p class="muted small">Signed in as <strong>{{ session.username }}</strong>.</p>
    <form class="stack" style="max-width: 360px" @submit.prevent="changePassword">
      <input type="text" name="username" autocomplete="username" :value="session.username" hidden readonly />
      <div class="field">
        <label for="cur">Current password</label>
        <input id="cur" v-model="current" type="password" autocomplete="current-password" required />
      </div>
      <div class="field">
        <label for="new">New password</label>
        <input id="new" v-model="next" type="password" autocomplete="new-password" required />
        <span class="hint">At least 8 characters.</span>
      </div>
      <div class="field">
        <label for="conf">Confirm new password</label>
        <input id="conf" v-model="confirm" type="password" autocomplete="new-password" required />
      </div>
      <div class="row">
        <button class="btn" :disabled="busy"><span v-if="busy" class="spin" />Change password</button>
        <span v-if="pwMsg" class="badge ok" role="status">{{ pwMsg }}</span>
      </div>
      <p v-if="pwErr" class="callout err" role="alert">{{ pwErr }}</p>
    </form>
  </section>
</template>
