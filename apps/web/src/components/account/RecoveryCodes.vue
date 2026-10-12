<script setup lang="ts">
/** Freshly made recovery codes: shown once, with Copy and Download, and an "I saved them" tick. */
import { computed, ref } from 'vue';
import { Check, Copy, Download } from 'lucide-vue-next';
import { session } from '../../lib/api.ts';
import { copyText } from '../folders/folderRules.ts';

const props = defineProps<{ codes: string[] }>();
const saved = defineModel<boolean>('saved', { default: false });

const text = computed(() =>
  [
    `ApexOs recovery codes${session.serverName ? ` for ${session.serverName}` : ''} (${session.username})`,
    `Made on ${new Date().toLocaleString()}`,
    '',
    'Each code works once. Use one to sign in when you can’t get a code from your authenticator app.',
    '',
    ...props.codes.map((c, i) => `${String(i + 1).padStart(2, ' ')}. ${c}`),
    '',
  ].join('\n'),
);

const copied = ref(false);
async function copy() {
  copied.value = await copyText(text.value);
  setTimeout(() => (copied.value = false), 2500);
}

function download() {
  const url = URL.createObjectURL(new Blob([text.value], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `apexos-recovery-codes${session.serverName ? `-${session.serverName}` : ''}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
</script>

<template>
  <div class="stack" style="--gap: 14px">
    <p class="small">
      If you lose your phone, each of these codes lets you sign in once. Keep them somewhere safe and separate from your phone, such as a password
      manager or a printout. <strong>They won’t be shown again.</strong>
    </p>
    <ol class="recovery-grid mono" aria-label="Recovery codes">
      <li v-for="c in codes" :key="c">{{ c }}</li>
    </ol>
    <div class="row wrap" style="--gap: 8px">
      <button type="button" class="btn small" @click="copy">
        <Check v-if="copied" :size="16" aria-hidden="true" />
        <Copy v-else :size="16" aria-hidden="true" />
        {{ copied ? 'Copied' : 'Copy all' }}
      </button>
      <button type="button" class="btn small" @click="download"><Download :size="16" aria-hidden="true" /> Download as text file</button>
    </div>
    <label class="row consent" style="--gap: 10px">
      <input v-model="saved" type="checkbox" />
      <span>I’ve saved these codes somewhere safe</span>
    </label>
  </div>
</template>

<style scoped>
.consent {
  align-items: flex-start;
  cursor: pointer;
}
.consent input {
  margin-top: 3px;
  flex: none;
}
</style>
