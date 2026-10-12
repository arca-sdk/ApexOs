<script setup lang="ts">
/** Create or edit a network-share user (username + password). */
import { computed, reactive, ref } from 'vue';
import type { ShareUser } from '@hearth/api-types';
import Modal from '../Modal.vue';
import PasswordInput from './PasswordInput.vue';
import { ApiError, api } from '../../lib/api.ts';
import { USERNAME_MAX, passwordProblem, usernameProblem } from '../folders/folderRules.ts';

const props = defineProps<{ user?: ShareUser | null; takenNames: string[] }>();
const emit = defineEmits<{ close: []; saved: [user: ShareUser] }>();

const editing = computed(() => !!props.user);
const username = ref(props.user?.username ?? '');
const password = ref('');
const errors = reactive<Record<string, string>>({});
const formError = ref('');
const busy = ref(false);

async function submit() {
  formError.value = '';
  for (const k of Object.keys(errors)) delete errors[k];
  const others = props.takenNames.filter((n) => n.toLowerCase() !== props.user?.username.toLowerCase());
  const uProblem = usernameProblem(username.value, others);
  if (uProblem) errors.username = uProblem;
  if (!editing.value || password.value) {
    const pProblem = passwordProblem(password.value);
    if (pProblem) errors.password = pProblem;
  }
  if (Object.keys(errors).length) return;

  busy.value = true;
  try {
    let saved: ShareUser;
    if (props.user) {
      const body: { username?: string; password?: string } = {};
      if (username.value.trim() !== props.user.username) body.username = username.value.trim();
      if (password.value) body.password = password.value;
      if (!Object.keys(body).length) return emit('close');
      saved = await api.put<ShareUser>(`/users/${props.user.id}`, body);
    } else {
      saved = await api.post<ShareUser>('/users', { username: username.value.trim(), password: password.value });
    }
    emit('saved', saved);
  } catch (e) {
    if (e instanceof ApiError) {
      Object.assign(errors, e.fields);
      if (!Object.keys(e.fields).length || (!e.fields.username && !e.fields.password)) formError.value = e.message;
    } else formError.value = String(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Modal :title="editing ? `Edit ${user!.username}` : 'Add a user'" @close="emit('close')">
    <p v-if="!editing" class="small muted">
      Users can open private folders from other computers. They can’t sign in to Hearth or change anything on the server.
    </p>
    <form id="user-form" class="stack" novalidate autocomplete="off" @submit.prevent="submit">
      <div class="field">
        <label for="uf-name">Username</label>
        <input
          id="uf-name"
          v-model="username"
          type="text"
          :maxlength="USERNAME_MAX"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          data-1p-ignore
          data-lpignore="true"
          data-bwignore
          :aria-invalid="!!errors.username || undefined"
          aria-describedby="uf-name-hint"
          required
          @input="delete errors.username"
        />
        <span id="uf-name-hint" class="hint">Up to {{ USERNAME_MAX }} letters, numbers, dashes or underscores, starting with a letter.</span>
        <span v-if="errors.username" class="error-text">{{ errors.username }}</span>
      </div>
      <div class="field">
        <label for="uf-pass">{{ editing ? 'New password' : 'Password' }}</label>
        <PasswordInput
          id="uf-pass"
          v-model="password"
          :required="!editing"
          :invalid="!!errors.password"
          describedby="uf-pass-hint"
          :placeholder="editing ? 'Leave empty to keep the current one' : undefined"
          @input="delete errors.password"
        />
        <span id="uf-pass-hint" class="hint">
          At least 8 characters. {{ editing ? 'Computers that saved the old password will ask for the new one.' : 'Share it with the person who’ll use this account.' }}
        </span>
        <span v-if="errors.password" class="error-text">{{ errors.password }}</span>
      </div>
      <p v-if="formError" class="callout err" role="alert">{{ formError }}</p>
    </form>
    <template #footer>
      <button class="btn" type="button" @click="emit('close')">Cancel</button>
      <button class="btn primary" type="submit" form="user-form" :disabled="busy">
        <span v-if="busy" class="spin" />{{ editing ? 'Save changes' : 'Add user' }}
      </button>
    </template>
  </Modal>
</template>
