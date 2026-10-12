<script setup lang="ts">
/**
 * Edit one network port or VLAN: automatic (DHCP) or a fixed address, plus the router and DNS
 * servers when the port is the one that provided them. Shows the change being tried out and how it ended.
 */
import { computed, ref } from 'vue';
import { TriangleAlert } from 'lucide-vue-next';
import type { InterfaceChangeRequest, NetworkInterfaceSettings, NetworkSettings, TaskStarted } from '@apexos/api-types';
import Modal from '../Modal.vue';
import NetworkTaskProgress from './NetworkTaskProgress.vue';
import { api } from '../../lib/api.ts';
import { browserUses, generalMessage, inSubnet, isIPv4, newApexOsUrl, outcome, PREFIX_OPTIONS, readError, useNetworkTask } from './network.ts';

const props = defineProps<{ iface: NetworkInterfaceSettings; settings: NetworkSettings }>();
const emit = defineEmits<{ close: [] }>();

const i = props.iface;
const s = props.settings;
const id = `nid-${i.name}`;

const dhcpAllowed = !s.dhcpInterface || s.dhcpInterface === i.name;
const mode = ref<'dhcp' | 'static'>(i.mode === 'static' || (i.mode === 'none' && !dhcpAllowed) ? 'static' : 'dhcp');
const current = i.configuredAddresses[0] ?? i.liveAddresses[0];
const address = ref(current?.address ?? '');
const prefix = ref(current?.prefix ?? 24);

const effectiveGateway = s.gateway.find(isIPv4) ?? '';
const gateway = ref(s.configuredGateway || effectiveGateway);
const startDns = s.configuredNameservers.length ? s.configuredNameservers : s.nameservers;
const dns = ref([startDns[0] ?? '', startDns[1] ?? '', startDns[2] ?? '']);

/** The port carries the default route (its network holds the gateway). */
const carriesGateway = !!effectiveGateway && i.liveAddresses.some((a) => inSubnet(effectiveGateway, a.address, a.prefix));
/** Router and DNS fields matter when this port stops (or isn't) getting them from DHCP. */
const showGlobals = computed(
  () => mode.value === 'static' && (s.dhcpInterface === i.name || (s.dhcpInterface === null && carriesGateway)),
);
const leavingDhcp = computed(() => mode.value === 'static' && s.dhcpInterface === i.name);
/** Switching to DHCP while the router and DNS servers are set by hand: offer to take them from DHCP too. */
const offerAutoGlobals = computed(() => mode.value === 'dhcp' && i.mode !== 'dhcp' && (!!s.configuredGateway || s.configuredNameservers.length > 0));
const autoGlobals = ref(true);

const ack = ref(false);
const browserHere = browserUses(i);

const fields = ref<Record<string, string>>({});
const formError = ref<string | null>(null);
const busy = ref(false);
const { task, start, taskId } = useNetworkTask();
const showProgress = computed(() => !!task.value);
const result = computed(() => (task.value ? outcome(task.value) : null));

const newUrl = computed(() => (mode.value === 'static' && isIPv4(address.value) ? newApexOsUrl(i, address.value.trim()) : null));
const savedText = computed(() =>
  mode.value === 'static'
    ? `Saved. ${i.name} now uses ${address.value.trim()}.`
    : `Saved. ${i.name} now gets its address automatically from your router.`,
);

function validate(): boolean {
  const f: Record<string, string> = {};
  if (mode.value === 'static') {
    if (!address.value.trim()) f.address = 'Enter the address the server should use';
    else if (!isIPv4(address.value)) f.address = 'Enter an IPv4 address like 192.168.1.50';
  }
  if (showGlobals.value) {
    if (!gateway.value.trim()) f.gateway = 'Enter your router’s address';
    else if (!isIPv4(gateway.value)) f.gateway = 'Enter an IPv4 address like 192.168.1.1';
    if (!dns.value.some((d) => d.trim())) f.nameservers = 'Enter at least one DNS server';
  }
  if (i.usedByApexOs && !ack.value) f.ack = 'Tick the box to confirm';
  fields.value = f;
  return !Object.keys(f).length;
}

async function save() {
  formError.value = null;
  if (!validate()) return;
  const body: InterfaceChangeRequest = { mode: mode.value };
  if (mode.value === 'static') {
    body.address = address.value.trim();
    body.prefix = prefix.value;
  }
  if (showGlobals.value) {
    body.gateway = gateway.value.trim();
    body.nameservers = dns.value.map((d) => d.trim()).filter(Boolean);
  }
  if (offerAutoGlobals.value && autoGlobals.value) {
    body.gateway = '';
    body.nameservers = [];
  }
  if (i.usedByApexOs) body.acknowledgeConnectionRisk = ack.value;
  busy.value = true;
  try {
    await start(api.put<TaskStarted>(`/system/network/interfaces/${encodeURIComponent(i.name)}`, body));
  } catch (e) {
    const err = readError(e);
    fields.value = err.fields;
    formError.value = generalMessage(err, [
      'mode',
      'ack',
      ...(mode.value === 'static' ? ['address', 'prefix'] : []),
      ...(showGlobals.value ? ['gateway', 'nameservers', 'nameservers.0', 'nameservers.1', 'nameservers.2'] : []),
    ]);
  } finally {
    busy.value = false;
  }
}

function editAgain() {
  taskId.value = null;
  ack.value = false;
}

const err = (key: string) => fields.value[key];
const dnsError = (idx: number) => fields.value[`nameservers.${idx}`];
</script>

<template>
  <Modal :title="`Edit ${i.name}`" @close="emit('close')">
    <template v-if="!showProgress">
      <p class="muted small">
        {{ i.vlan ? `VLAN ${i.vlan.tag} on ${i.vlan.parent}` : 'Network port' }}<template v-if="i.description"> · {{ i.description }}</template>
        · now {{ i.liveAddresses.length ? i.liveAddresses.map((a) => `${a.address}/${a.prefix}`).join(', ') : 'no address' }}
      </p>

      <form :id="`${id}-form`" class="stack" style="--gap: 16px" novalidate @submit.prevent="save">
        <fieldset class="plain stack" style="--gap: 8px">
          <legend class="field-label">How should {{ i.name }} get its address?</legend>
          <label class="choice" :class="{ selected: mode === 'dhcp', disabled: !dhcpAllowed }">
            <input v-model="mode" type="radio" :name="`${id}-mode`" value="dhcp" :disabled="!dhcpAllowed" :aria-describedby="`${id}-dhcp-hint`" />
            <span class="stack" style="--gap: 2px">
              <span>Automatically (DHCP)</span>
              <span :id="`${id}-dhcp-hint`" class="small muted">
                <template v-if="dhcpAllowed">Your router picks the address. Easiest, but the address can change unless your router reserves it.</template>
                <template v-else>Not available: only one connection can do this, and {{ s.dhcpInterface }} already does.</template>
              </span>
            </span>
          </label>
          <label class="choice" :class="{ selected: mode === 'static' }">
            <input v-model="mode" type="radio" :name="`${id}-mode`" value="static" />
            <span class="stack" style="--gap: 2px">
              <span>Fixed address</span>
              <span class="small muted">The server always uses the address you choose. Pick one your router doesn’t hand out to other devices.</span>
            </span>
          </label>
          <p v-if="err('mode')" class="error-text small" role="alert">{{ err('mode') }}</p>
        </fieldset>

        <div v-if="mode === 'static'" class="pair">
          <div class="field">
            <label :for="`${id}-addr`">IP address</label>
            <input
              :id="`${id}-addr`"
              v-model="address"
              type="text"
              inputmode="decimal"
              autocomplete="off"
              spellcheck="false"
              placeholder="192.168.1.50"
              :aria-invalid="!!err('address')"
              :aria-describedby="err('address') ? `${id}-addr-err` : undefined"
            />
            <span v-if="err('address')" :id="`${id}-addr-err`" class="error-text">{{ err('address') }}</span>
          </div>
          <div class="field">
            <label :for="`${id}-mask`">Subnet mask</label>
            <select :id="`${id}-mask`" v-model.number="prefix" :aria-invalid="!!err('prefix')">
              <option v-for="o in PREFIX_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
            <span v-if="err('prefix')" class="error-text">{{ err('prefix') }}</span>
            <span v-else class="hint">Most home networks use 255.255.255.0.</span>
          </div>
        </div>

        <div v-if="showGlobals" class="stack globals" style="--gap: 12px">
          <p class="small">
            <template v-if="leavingDhcp">
              Right now your router also tells the server which router and DNS servers to use. With a fixed address, ApexOs sets them by hand
              first, so the server stays online. These are the ones in use now:
            </template>
            <template v-else>The server’s internet connection goes through this port:</template>
          </p>
          <div class="field">
            <label :for="`${id}-gw`">Router (gateway)</label>
            <input
              :id="`${id}-gw`"
              v-model="gateway"
              type="text"
              inputmode="decimal"
              autocomplete="off"
              spellcheck="false"
              placeholder="192.168.1.1"
              :aria-invalid="!!err('gateway')"
              :aria-describedby="`${id}-gw-hint`"
            />
            <span v-if="err('gateway')" class="error-text">{{ err('gateway') }}</span>
            <span v-else :id="`${id}-gw-hint`" class="hint">Usually your router’s address. It must be in the same network as the server.</span>
          </div>
          <fieldset class="plain field">
            <legend class="field-label">DNS servers</legend>
            <div class="dns">
              <div v-for="(_, idx) in dns" :key="idx" class="stack" style="--gap: 4px">
                <label :for="`${id}-dns-${idx}`" class="sr-only">DNS server {{ idx + 1 }}</label>
                <input
                  :id="`${id}-dns-${idx}`"
                  v-model="dns[idx]"
                  type="text"
                  autocomplete="off"
                  spellcheck="false"
                  :placeholder="idx === 0 ? '192.168.1.1' : 'Optional'"
                  :aria-invalid="!!dnsError(idx)"
                />
                <span v-if="dnsError(idx)" class="error-text">{{ dnsError(idx) }}</span>
              </div>
            </div>
            <span v-if="err('nameservers')" class="error-text">{{ err('nameservers') }}</span>
            <span class="hint">They turn names like truenas.com into addresses. Your router’s address usually works.</span>
          </fieldset>
        </div>

        <label v-if="offerAutoGlobals" class="row consent" style="--gap: 10px">
          <input v-model="autoGlobals" type="checkbox" />
          <span>Also take the router and DNS servers from DHCP (they are set by hand now)</span>
        </label>

        <div v-if="i.usedByApexOs" class="callout warn stack" style="--gap: 8px">
          <strong class="row" style="--gap: 8px"><TriangleAlert :size="16" /> ApexOs talks to TrueNAS through {{ i.name }}</strong>
          <span class="small">
            While TrueNAS tries the new settings, the connection drops for a moment. If ApexOs can’t reach the server afterwards, TrueNAS goes
            back to the current settings by itself after {{ s.checkinTimeoutSeconds }} seconds.
          </span>
          <span v-if="mode === 'dhcp' && i.mode !== 'dhcp'" class="small">
            With automatic addressing your router picks the address. ApexOs can only follow if the router hands out the same address or the
            server can be found by its name; otherwise the change is undone.
          </span>
          <span v-if="browserHere" class="small">
            You’re also using ApexOs through this address, so ApexOs probably runs on this server. Its address changes too: afterwards, open
            ApexOs at the new address<template v-if="newUrl"> ({{ newUrl.replace(/\/settings.*$/, '') }})</template>.
          </span>
          <label class="row consent" style="--gap: 10px">
            <input v-model="ack" type="checkbox" :aria-invalid="!!err('ack')" />
            <span>I understand the connection may drop for a moment.</span>
          </label>
          <span v-if="err('ack')" class="error-text small">{{ err('ack') }}</span>
        </div>

        <p v-if="formError" class="callout err" role="alert">{{ formError }}</p>
      </form>
    </template>

    <NetworkTaskProgress v-else-if="task" :task="task" :new-url="newUrl" :saved-text="savedText" />

    <template #footer>
      <template v-if="!showProgress">
        <button class="btn" type="button" @click="emit('close')">Cancel</button>
        <button class="btn primary" type="submit" :form="`${id}-form`" :disabled="busy || (i.usedByApexOs && !ack)">
          <span v-if="busy" class="spin" />Save
        </button>
      </template>
      <template v-else>
        <span v-if="result === 'running'" class="small muted">You can close this; the change continues.</span>
        <button v-if="result === 'restored' || result === 'failed'" class="btn" type="button" @click="editAgain">Change settings</button>
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
.globals {
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
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
.consent {
  align-items: flex-start;
}
.consent input {
  margin-top: 3px;
  flex: none;
}
input[aria-invalid='true'],
select[aria-invalid='true'] {
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
