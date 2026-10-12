<script setup lang="ts">
/** Network address of a shared folder, with a Mac/Linux vs Windows format switch, copy button and short how-to. */
import { computed, ref, useId, watch } from 'vue';
import { Check, Copy } from 'lucide-vue-next';
import type { Folder } from '@hearth/api-types';
import { copyText, detectOs, folderAddress, rememberOs, type ConnectOs } from './folderRules.ts';

const props = defineProps<{ folder: Folder }>();

const os = ref<ConnectOs>(detectOs());
watch(os, rememberOs);
const copied = ref(false);
const copyFailed = ref(false);
const uid = useId();
const addressId = `addr-${uid}`;

const address = computed(() => folderAddress(props.folder, os.value));

const options: { value: ConnectOs; label: string }[] = [
  { value: 'mac', label: 'Mac or Linux' },
  { value: 'windows', label: 'Windows' },
];

let timer: ReturnType<typeof setTimeout> | undefined;
async function copy() {
  if (!address.value) return;
  const ok = await copyText(address.value);
  copied.value = ok;
  copyFailed.value = !ok;
  clearTimeout(timer);
  timer = setTimeout(() => (copied.value = copyFailed.value = false), 2500);
}

function onSegmentKey(e: KeyboardEvent) {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  e.preventDefault();
  os.value = os.value === 'mac' ? 'windows' : 'mac';
  const target = (e.currentTarget as HTMLElement).parentElement?.querySelector<HTMLElement>(`[data-os="${os.value}"]`);
  target?.focus();
}
</script>

<template>
  <div class="stack" style="--gap: 10px">
    <div class="segmented" role="radiogroup" aria-label="Your computer">
      <button
        v-for="o in options"
        :key="o.value"
        type="button"
        role="radio"
        :data-os="o.value"
        :aria-checked="os === o.value"
        :tabindex="os === o.value ? 0 : -1"
        class="seg"
        :class="{ on: os === o.value }"
        @click="os = o.value"
        @keydown="onSegmentKey"
      >
        {{ o.label }}
      </button>
    </div>

    <template v-if="address">
      <label :for="addressId" class="sr-only">Network address</label>
      <div class="row address" style="--gap: 8px">
        <input :id="addressId" class="mono" type="text" readonly :value="address" @focus="($event.target as HTMLInputElement).select()" />
        <button type="button" class="btn small" :aria-label="`Copy address ${address}`" @click="copy">
          <Check v-if="copied" :size="16" />
          <Copy v-else :size="16" />
          {{ copied ? 'Copied' : 'Copy' }}
        </button>
      </div>
      <p class="sr-only" aria-live="polite">{{ copied ? 'Address copied' : copyFailed ? 'Could not copy. Select the address and copy it yourself.' : '' }}</p>
      <p v-if="copyFailed" class="small" style="color: var(--err)">Your browser blocked copying. Select the address above and copy it yourself.</p>

      <div class="small muted howto">
        <template v-if="os === 'mac'">
          <p><strong>Mac:</strong> in Finder choose <em>Go → Connect to Server</em> (⌘K), paste the address and click Connect.</p>
          <p><strong>Linux:</strong> in your file manager open <em>Other Locations</em> (or <em>Connect to Server</em>) and paste the address.</p>
        </template>
        <template v-else>
          <p>Paste the address into the File Explorer address bar and press Enter. To keep it handy, right-click <em>This PC</em> and choose <em>Map network drive</em>.</p>
          <p v-if="folder.access === 'public'">
            Windows 11 sometimes refuses folders that don’t ask for a password. If it won’t open, make the folder private and give yourself a user.
          </p>
        </template>
        <p v-if="folder.access === 'private'">Sign in with a username and password from the Users page when asked.</p>
        <p v-else>No password needed: anyone on your home network can open it.</p>
      </div>
    </template>
    <p v-else class="small muted">The server’s network address isn’t known yet, so the connection address can’t be shown.</p>
  </div>
</template>

<style scoped>
.segmented {
  display: inline-flex;
  align-self: flex-start;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 2px;
  gap: 2px;
}
.seg {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  font-size: 0.87rem;
  font-weight: 550;
  padding: 4px 12px;
  border-radius: 6px;
  cursor: pointer;
}
.seg.on {
  background: var(--surface);
  color: var(--text);
  box-shadow: var(--shadow);
}
.seg:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.address input {
  flex: 1;
  min-width: 0;
  font-size: 0.88rem;
}
.howto {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
</style>
