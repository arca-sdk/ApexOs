<script setup lang="ts">
/** Add a VLAN on one of the physical ports, with an automatic or fixed address. */
import { computed, ref } from 'vue';
import type { NetworkSettings, TaskStarted, VlanCreateRequest } from '@apexos/api-types';
import Modal from '../Modal.vue';
import NetworkTaskProgress from './NetworkTaskProgress.vue';
import { api } from '../../lib/api.ts';
import { generalMessage, isIPv4, outcome, PREFIX_OPTIONS, readError, useNetworkTask } from './network.ts';

const props = defineProps<{ settings: NetworkSettings }>();
const emit = defineEmits<{ close: [] }>();
const s = props.settings;

const parents = s.interfaces.filter((i) => i.type === 'PHYSICAL');
const parent = ref(parents.find((p) => p.usedByApexOs)?.name ?? parents[0]?.name ?? '');
const tag = ref<number | ''>('');
const description = ref('');
const dhcpAllowed = s.dhcpInterface === null;
const mode = ref<'dhcp' | 'static'>(dhcpAllowed ? 'dhcp' : 'static');
const address = ref('');
const prefix = ref(24);

const fields = ref<Record<string, string>>({});
const formError = ref<string | null>(null);
const busy = ref(false);
const { task, start, taskId } = useNetworkTask();
const result = computed(() => (task.value ? outcome(task.value) : null));

function validate(): boolean {
  const f: Record<string, string> = {};
  if (!parent.value) f.parent = 'Choose the network port the VLAN runs on';
  if (tag.value === '' || !Number.isInteger(tag.value) || tag.value < 1 || tag.value > 4094) f.tag = 'Use a VLAN number from 1 to 4094';
  if (mode.value === 'static') {
    if (!address.value.trim()) f.address = 'Enter the address the server should use on this VLAN';
    else if (!isIPv4(address.value)) f.address = 'Enter an IPv4 address like 10.0.20.2';
  }
  fields.value = f;
  return !Object.keys(f).length;
}

async function save() {
  formError.value = null;
  if (!validate()) return;
  const body: VlanCreateRequest = { parent: parent.value, tag: Number(tag.value), mode: mode.value, description: description.value.trim() };
  if (mode.value === 'static') {
    body.address = address.value.trim();
    body.prefix = prefix.value;
  }
  busy.value = true;
  try {
    await start(api.post<TaskStarted>('/system/network/vlans', body));
  } catch (e) {
    const err = readError(e);
    fields.value = err.fields;
    formError.value = generalMessage(err, ['parent', 'tag', 'description', 'mode', ...(mode.value === 'static' ? ['address', 'prefix'] : [])]);
  } finally {
    busy.value = false;
  }
}

const err = (key: string) => fields.value[key];
</script>

<template>
  <Modal title="Add a VLAN" @close="emit('close')">
    <template v-if="!task">
      <p class="muted small">
        A VLAN is a separate virtual network that shares a cable with your regular network, for example to keep cameras apart. Your switch
        or router has to be set up with the same VLAN number, or devices on it won’t reach the server.
      </p>
      <form id="nv-form" class="stack" style="--gap: 16px" novalidate @submit.prevent="save">
        <div class="pair">
          <div class="field">
            <label for="nv-parent">Network port</label>
            <select id="nv-parent" v-model="parent" :aria-invalid="!!err('parent')">
              <option v-for="p in parents" :key="p.name" :value="p.name">{{ p.name }}{{ p.linkUp ? '' : ' (not connected)' }}</option>
            </select>
            <span v-if="err('parent')" class="error-text">{{ err('parent') }}</span>
          </div>
          <div class="field">
            <label for="nv-tag">VLAN number</label>
            <input
              id="nv-tag"
              v-model.number="tag"
              type="number"
              min="1"
              max="4094"
              step="1"
              inputmode="numeric"
              placeholder="20"
              :aria-invalid="!!err('tag')"
              aria-describedby="nv-tag-hint"
            />
            <span v-if="err('tag')" class="error-text">{{ err('tag') }}</span>
            <span v-else id="nv-tag-hint" class="hint">1 to 4094, the same as on your switch.</span>
          </div>
        </div>

        <div class="field">
          <label for="nv-desc">Description <span class="muted">(optional)</span></label>
          <input id="nv-desc" v-model="description" type="text" maxlength="120" placeholder="Cameras" :aria-invalid="!!err('description')" />
          <span v-if="err('description')" class="error-text">{{ err('description') }}</span>
        </div>

        <fieldset class="plain stack" style="--gap: 8px">
          <legend class="field-label">Address on the VLAN</legend>
          <label class="choice" :class="{ selected: mode === 'dhcp', disabled: !dhcpAllowed }">
            <input v-model="mode" type="radio" name="nv-mode" value="dhcp" :disabled="!dhcpAllowed" />
            <span class="stack" style="--gap: 2px">
              <span>Automatically (DHCP)</span>
              <span class="small muted">
                <template v-if="dhcpAllowed">A DHCP server on the VLAN picks the address.</template>
                <template v-else>Not available: only one connection can do this, and {{ s.dhcpInterface }} already does.</template>
              </span>
            </span>
          </label>
          <label class="choice" :class="{ selected: mode === 'static' }">
            <input v-model="mode" type="radio" name="nv-mode" value="static" />
            <span class="stack" style="--gap: 2px">
              <span>Fixed address</span>
              <span class="small muted">The address the server uses on the VLAN’s network.</span>
            </span>
          </label>
          <p v-if="err('mode')" class="error-text" role="alert">{{ err('mode') }}</p>
        </fieldset>

        <div v-if="mode === 'static'" class="pair">
          <div class="field">
            <label for="nv-addr">IP address</label>
            <input
              id="nv-addr"
              v-model="address"
              type="text"
              inputmode="decimal"
              autocomplete="off"
              spellcheck="false"
              placeholder="10.0.20.2"
              :aria-invalid="!!err('address')"
            />
            <span v-if="err('address')" class="error-text">{{ err('address') }}</span>
          </div>
          <div class="field">
            <label for="nv-mask">Subnet mask</label>
            <select id="nv-mask" v-model.number="prefix">
              <option v-for="o in PREFIX_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
            <span v-if="err('prefix')" class="error-text">{{ err('prefix') }}</span>
            <span v-else class="hint">Most home networks use 255.255.255.0.</span>
          </div>
        </div>

        <p v-if="formError" class="callout err" role="alert">{{ formError }}</p>
      </form>
    </template>

    <NetworkTaskProgress v-else :task="task" :saved-text="`Saved. VLAN ${tag} is set up on ${parent}.`" />

    <template #footer>
      <template v-if="!task">
        <button class="btn" type="button" @click="emit('close')">Cancel</button>
        <button class="btn primary" type="submit" form="nv-form" :disabled="busy || !parents.length">
          <span v-if="busy" class="spin" />Add VLAN
        </button>
      </template>
      <template v-else>
        <button v-if="result === 'restored' || result === 'failed'" class="btn" type="button" @click="taskId = null">Change settings</button>
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
.choice {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.choice input {
  margin-top: 4px;
  flex: none;
}
.choice.selected {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.choice.disabled {
  cursor: not-allowed;
  opacity: 0.7;
}
.pair {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: 12px;
}
.error-text {
  font-size: 0.84rem;
  color: var(--err);
}
input[aria-invalid='true'],
select[aria-invalid='true'] {
  border-color: var(--err);
}
</style>
