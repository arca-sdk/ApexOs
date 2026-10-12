<script setup lang="ts">
/** The server's router (default gateway) and DNS servers: from DHCP or set by hand. */
import { computed, ref } from 'vue';
import type { DnsChangeRequest, NetworkSettings, TaskStarted } from '@apexos/api-types';
import Modal from '../Modal.vue';
import NetworkTaskProgress from './NetworkTaskProgress.vue';
import { api } from '../../lib/api.ts';
import { generalMessage, isIPv4, outcome, readError, useNetworkTask } from './network.ts';

const props = defineProps<{ settings: NetworkSettings }>();
const emit = defineEmits<{ close: [] }>();
const s = props.settings;

/** Without a DHCP connection there is nothing to take them from automatically. */
const autoPossible = s.dhcpInterface !== null;
const dnsMode = ref<'auto' | 'manual'>(s.configuredNameservers.length || !autoPossible ? 'manual' : 'auto');
const gwMode = ref<'auto' | 'manual'>(s.configuredGateway || !autoPossible ? 'manual' : 'auto');
const startDns = s.configuredNameservers.length ? s.configuredNameservers : s.nameservers;
const dns = ref([startDns[0] ?? '', startDns[1] ?? '', startDns[2] ?? '']);
const gateway = ref(s.configuredGateway || (s.gateway.find(isIPv4) ?? ''));

const fields = ref<Record<string, string>>({});
const formError = ref<string | null>(null);
const busy = ref(false);
const { task, start, taskId } = useNetworkTask();
const result = computed(() => (task.value ? outcome(task.value) : null));

function validate(): boolean {
  const f: Record<string, string> = {};
  if (dnsMode.value === 'manual' && !dns.value.some((d) => d.trim())) f.nameservers = 'Enter at least one DNS server';
  if (gwMode.value === 'manual') {
    if (!gateway.value.trim()) f.gateway = 'Enter your router’s address';
    else if (!isIPv4(gateway.value)) f.gateway = 'Enter an IPv4 address like 192.168.1.1';
  }
  fields.value = f;
  return !Object.keys(f).length;
}

async function save() {
  formError.value = null;
  if (!validate()) return;
  const body: DnsChangeRequest = {
    nameservers: dnsMode.value === 'manual' ? dns.value.map((d) => d.trim()).filter(Boolean) : [],
    gateway: gwMode.value === 'manual' ? gateway.value.trim() : '',
  };
  busy.value = true;
  try {
    await start(api.put<TaskStarted>('/system/network/dns', body));
  } catch (e) {
    const err = readError(e);
    fields.value = err.fields;
    formError.value = generalMessage(err, [
      ...(dnsMode.value === 'manual' ? ['nameservers', 'nameservers.0', 'nameservers.1', 'nameservers.2'] : []),
      ...(gwMode.value === 'manual' ? ['gateway'] : []),
    ]);
  } finally {
    busy.value = false;
  }
}

const err = (key: string) => fields.value[key];
</script>

<template>
  <Modal title="Internet access" @close="emit('close')">
    <template v-if="!task">
      <p class="muted small">
        The router (default gateway) is where the server sends traffic for the internet. DNS servers turn names like truenas.com into
        addresses. Both apply to the whole server.
      </p>
      <p v-if="!autoPossible" class="callout small">No connection gets its address automatically, so both have to be set by hand.</p>

      <form id="nd-form" class="stack" style="--gap: 18px" novalidate @submit.prevent="save">
        <fieldset class="plain stack" style="--gap: 8px">
          <legend class="field-label">DNS servers</legend>
          <div class="seg">
            <label :class="{ selected: dnsMode === 'auto', disabled: !autoPossible }">
              <input v-model="dnsMode" type="radio" name="nd-dns" value="auto" :disabled="!autoPossible" /> From your router
            </label>
            <label :class="{ selected: dnsMode === 'manual' }">
              <input v-model="dnsMode" type="radio" name="nd-dns" value="manual" /> Set by hand
            </label>
          </div>
          <p v-if="dnsMode === 'auto'" class="small muted">
            In use now: <span class="mono">{{ s.nameserversFromDhcp ? s.nameservers.join(', ') : 'none yet' }}</span>
          </p>
          <template v-else>
            <div class="dns">
              <div v-for="(_, idx) in dns" :key="idx" class="stack" style="--gap: 4px">
                <label :for="`nd-dns-${idx}`" class="small">{{ ['First', 'Second', 'Third'][idx] }}{{ idx ? ' (optional)' : '' }}</label>
                <input
                  :id="`nd-dns-${idx}`"
                  v-model="dns[idx]"
                  type="text"
                  autocomplete="off"
                  spellcheck="false"
                  :placeholder="idx === 0 ? '192.168.1.1' : ''"
                  :aria-invalid="!!err(`nameservers.${idx}`)"
                />
                <span v-if="err(`nameservers.${idx}`)" class="error-text">{{ err(`nameservers.${idx}`) }}</span>
              </div>
            </div>
            <span v-if="err('nameservers')" class="error-text">{{ err('nameservers') }}</span>
            <span class="hint small muted">Your router’s address usually works. Public ones such as 1.1.1.1 or 9.9.9.9 do too.</span>
          </template>
        </fieldset>

        <fieldset class="plain stack" style="--gap: 8px">
          <legend class="field-label">Router (gateway)</legend>
          <div class="seg">
            <label :class="{ selected: gwMode === 'auto', disabled: !autoPossible }">
              <input v-model="gwMode" type="radio" name="nd-gw" value="auto" :disabled="!autoPossible" /> From your router
            </label>
            <label :class="{ selected: gwMode === 'manual' }">
              <input v-model="gwMode" type="radio" name="nd-gw" value="manual" /> Set by hand
            </label>
          </div>
          <p v-if="gwMode === 'auto'" class="small muted">
            In use now: <span class="mono">{{ s.gatewayFromDhcp ? s.gateway.join(', ') : 'none yet' }}</span>
          </p>
          <div v-else class="field">
            <label for="nd-gw-input" class="sr-only">Router address</label>
            <input
              id="nd-gw-input"
              v-model="gateway"
              type="text"
              inputmode="decimal"
              autocomplete="off"
              spellcheck="false"
              placeholder="192.168.1.1"
              :aria-invalid="!!err('gateway')"
            />
            <span v-if="err('gateway')" class="error-text">{{ err('gateway') }}</span>
            <span v-else class="hint">It must be in the same network as one of the server’s addresses.</span>
          </div>
        </fieldset>

        <p class="small muted">
          A wrong router address cuts the server off from the internet (shared folders on your network keep working), so double-check it.
        </p>
        <p v-if="formError" class="callout err" role="alert">{{ formError }}</p>
      </form>
    </template>

    <NetworkTaskProgress v-else :task="task" saved-text="Saved. The server uses the new DNS servers and router." />

    <template #footer>
      <template v-if="!task">
        <button class="btn" type="button" @click="emit('close')">Cancel</button>
        <button class="btn primary" type="submit" form="nd-form" :disabled="busy"><span v-if="busy" class="spin" />Save</button>
      </template>
      <template v-else>
        <button v-if="result === 'failed'" class="btn" type="button" @click="taskId = null">Change settings</button>
        <button class="btn" :class="{ primary: result !== 'running' }" type="button" @click="emit('close')">
          {{ result === 'running' ? 'Close' : 'Done' }}
        </button>
      </template>
    </template>
  </Modal>
</template>

<style scoped>
.plain {
  border: 0;
  margin: 0;
  padding: 0;
  min-width: 0;
}
.plain legend {
  padding: 0;
  margin-bottom: 6px;
}
.seg {
  display: inline-flex;
  flex-wrap: wrap;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  overflow: hidden;
  align-self: flex-start;
}
.seg label {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 14px;
  cursor: pointer;
  font-size: 0.92rem;
}
.seg label + label {
  border-left: 1px solid var(--border);
}
.seg label.selected {
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-weight: 550;
}
.seg label.disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
.seg label:focus-within {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.dns {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 8px;
}
.error-text {
  font-size: 0.84rem;
  color: var(--err);
}
input[aria-invalid='true'] {
  border-color: var(--err);
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
</style>
