<script setup lang="ts">
/** "Sign out everywhere": ends every ApexOs session, including this one. */
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { LogOut } from 'lucide-vue-next';
import { api, session } from '../../lib/api.ts';
import ConfirmDialog from '../ConfirmDialog.vue';

const router = useRouter();
const open = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);

async function signOutEverywhere() {
  busy.value = true;
  error.value = null;
  try {
    await api.post('/auth/sign-out-everywhere');
    open.value = false;
    session.authenticated = false;
    await router.replace('/login');
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="card stack" aria-labelledby="se-h">
    <h2 id="se-h">Signed-in devices</h2>
    <p class="small muted">
      If you signed in on a computer that isn’t yours, or think someone else knows your password, sign out every browser and device at once. You’ll
      need to sign in again here too. Changing your password also signs out your other browsers.
    </p>
    <div>
      <button class="btn" @click="(error = null), (open = true)"><LogOut :size="16" aria-hidden="true" /> Sign out everywhere</button>
    </div>
  </section>

  <ConfirmDialog
    v-if="open"
    title="Sign out everywhere?"
    message="Every browser and device signed in to ApexOs will be signed out, including this one."
    action-label="Sign out everywhere"
    :busy="busy"
    :error="error"
    @confirm="signOutEverywhere"
    @close="open = false"
  />
</template>
