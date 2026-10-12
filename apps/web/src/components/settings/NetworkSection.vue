<script setup lang="ts">
/**
 * The server's network: router and DNS servers, network ports (DHCP or a fixed address) and VLANs.
 * Every change runs as a server task that TrueNAS undoes by itself unless ApexOs confirms it.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Cable, Layers, Pencil, Plus, Trash2, X } from 'lucide-vue-next';
import type { NetworkInterfaceSettings, NetworkSettings, Task, TaskStarted } from '@apexos/api-types';
import ConfirmDialog from '../ConfirmDialog.vue';
import PageState from '../PageState.vue';
import NetworkDnsDialog from './NetworkDnsDialog.vue';
import NetworkInterfaceDialog from './NetworkInterfaceDialog.vue';
import NetworkTaskProgress from './NetworkTaskProgress.vue';
import NetworkVlanDialog from './NetworkVlanDialog.vue';
import { api } from '../../lib/api.ts';
import { live, onServerChange, waitForTask } from '../../lib/events.ts';
import { addressList, modeLabel, readError, speed } from './network.ts';

const info = ref<NetworkSettings | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);

async function load() {
  error.value = null;
  try {
    info.value = await api.get<NetworkSettings>('/system/network');
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}
function retry() {
  loading.value = true;
  load();
}
onMounted(load);
onServerChange(['system', 'truenas-connected'], load);

// While TrueNAS waits for someone else's confirmation, keep the countdown fresh.
let poll: ReturnType<typeof setTimeout> | undefined;
watch(
  () => info.value?.rollbackSecondsLeft,
  (left) => {
    clearTimeout(poll);
    if (left !== null && left !== undefined) poll = setTimeout(load, 3_000);
  },
);

const now = ref(Date.now());
const clock = setInterval(() => (now.value = Date.now()), 10_000);
onBeforeUnmount(() => {
  clearInterval(clock);
  clearTimeout(poll);
});

const ports = computed(() => info.value?.interfaces.filter((i) => i.type !== 'VLAN') ?? []);
const vlans = computed(() => info.value?.interfaces.filter((i) => i.type === 'VLAN') ?? []);

// ---- the latest network change (running, or finished in the last two minutes) ----
const dismissed = ref(new Set<string>());
const recent = computed<Task | null>(() => {
  const latest = Object.values(live.tasks)
    .filter((t) => t.type === 'network')
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  if (!latest || dismissed.value.has(latest.id)) return null;
  const fresh = latest.status === 'running' || (latest.finishedAt && now.value - Date.parse(latest.finishedAt) < 120_000);
  return fresh ? latest : null;
});
const running = computed(() => recent.value?.status === 'running');
watch(
  () => recent.value?.status,
  (status, previous) => {
    if (previous === 'running' && status !== 'running') load();
  },
);
/** Changes wait while one is running or while TrueNAS holds changes from elsewhere. */
const locked = computed(() => running.value || !!info.value?.pendingChanges || info.value?.rollbackSecondsLeft != null);

// ---- dialogs ----
const editing = ref<NetworkInterfaceSettings | null>(null);
const dnsOpen = ref(false);
const vlanOpen = ref(false);
function closeDialog() {
  editing.value = null;
  dnsOpen.value = false;
  vlanOpen.value = false;
  load();
}

// ---- removing a VLAN ----
const removing = ref<NetworkInterfaceSettings | null>(null);
const removeBusy = ref(false);
const removeError = ref<string | null>(null);
function askRemove(vlan: NetworkInterfaceSettings) {
  removeError.value = null;
  removing.value = vlan;
}
async function confirmRemove() {
  if (!removing.value) return;
  removeBusy.value = true;
  removeError.value = null;
  try {
    const { task } = await api.del<TaskStarted>(`/system/network/vlans/${encodeURIComponent(removing.value.name)}`);
    live.tasks[task.id] ??= task;
    waitForTask(task.id).catch(() => undefined);
    removing.value = null;
  } catch (e) {
    removeError.value = readError(e).message;
  } finally {
    removeBusy.value = false;
  }
}

// ---- changes left over in the TrueNAS UI ----
const discarding = ref(false);
const discardError = ref<string | null>(null);
async function discard() {
  discarding.value = true;
  discardError.value = null;
  try {
    await api.post('/system/network/discard');
    await load();
  } catch (e) {
    discardError.value = readError(e).message;
  } finally {
    discarding.value = false;
  }
}

function vlanLine(i: NetworkInterfaceSettings): string {
  return i.vlan ? `VLAN ${i.vlan.tag} on ${i.vlan.parent}` : '';
}
</script>

<template>
  <section class="card stack" aria-labelledby="ns-h">
    <h2 id="ns-h">Network</h2>
    <p class="muted small">
      How your server connects to your network. Every change is tried out first: if ApexOs can’t reach the server afterwards, TrueNAS
      puts the previous settings back by itself.
    </p>
    <PageState :loading="loading" :error="error" @retry="retry">
      <template v-if="info">
        <div v-if="info.pendingChanges" class="callout warn stack" style="--gap: 8px">
          <span>
            TrueNAS has network changes that were never applied, probably started in the TrueNAS web interface. ApexOs can’t change the network
            until they are applied there or discarded.
          </span>
          <div class="row wrap" style="--gap: 10px">
            <button class="btn small" :disabled="discarding" @click="discard"><span v-if="discarding" class="spin" />Discard them</button>
            <span v-if="discardError" class="small" style="color: var(--err)" role="alert">{{ discardError }}</span>
          </div>
        </div>
        <p v-if="info.rollbackSecondsLeft !== null && !running" class="callout warn" role="status">
          TrueNAS is trying out new network settings, probably from the TrueNAS web interface. Unless they are confirmed there, it puts the
          previous settings back in {{ info.rollbackSecondsLeft }} seconds.
        </p>

        <div v-if="recent" class="card flat recent">
          <button v-if="!running" class="btn ghost small dismiss" aria-label="Hide this result" @click="dismissed = new Set([...dismissed, recent.id])">
            <X :size="14" />
          </button>
          <NetworkTaskProgress :task="recent" />
        </div>

        <div class="stack" style="--gap: 10px">
          <div class="row wrap" style="--gap: 8px">
            <h3>Internet access</h3>
            <span class="spacer" />
            <button class="btn small" :disabled="locked" @click="dnsOpen = true"><Pencil :size="14" /> Change</button>
          </div>
          <dl class="facts">
            <dt>Server name</dt>
            <dd>
              <span class="mono">{{ info.hostname }}</span>
              <RouterLink class="small change-name" :to="{ path: '/settings', query: { section: 'general' } }">Change</RouterLink>
            </dd>
            <dt>Router (gateway)</dt>
            <dd>
              <span class="mono">{{ info.gateway.length ? info.gateway.join(', ') : 'None' }}</span>
              <span v-if="info.gateway.length" class="badge">{{ info.configuredGateway ? 'Set by hand' : 'Automatic' }}</span>
            </dd>
            <dt>DNS servers</dt>
            <dd>
              <span class="mono">{{ info.nameservers.length ? info.nameservers.join(', ') : 'None' }}</span>
              <span v-if="info.nameservers.length" class="badge">{{ info.configuredNameservers.length ? 'Set by hand' : 'Automatic' }}</span>
            </dd>
          </dl>
          <p v-if="!info.gateway.length || !info.nameservers.length" class="callout warn small">
            Without {{ !info.gateway.length ? 'a router' : 'DNS servers' }} the server can’t reach the internet, so updates and app installs
            fail. Set {{ !info.gateway.length ? 'one' : 'them' }} with Change.
          </p>
        </div>

        <div class="stack" style="--gap: 10px">
          <h3>Network ports</h3>
          <p v-if="!ports.length" class="muted small">No network ports found.</p>
          <ul class="ifaces">
            <li v-for="i in ports" :key="i.name" class="card flat stack" style="--gap: 8px">
              <div class="row wrap" style="--gap: 8px">
                <Cable :size="16" class="muted" aria-hidden="true" />
                <strong class="mono">{{ i.name }}</strong>
                <span class="badge" :class="i.linkUp ? 'ok' : ''">{{ i.linkUp ? 'Connected' : 'Not connected' }}</span>
                <span v-if="i.linkUp && i.speedMbps" class="small muted">{{ speed(i.speedMbps) }}</span>
                <span v-if="i.usedByApexOs" class="badge info">ApexOs connects here</span>
                <span class="spacer" />
                <button v-if="i.editable" class="btn small" :disabled="locked" :aria-label="`Edit ${i.name}`" @click="editing = i">
                  <Pencil :size="14" /> Edit
                </button>
              </div>
              <dl class="facts small">
                <dt>Address setup</dt>
                <dd>{{ modeLabel(i.mode) }}</dd>
                <dt>IP addresses</dt>
                <dd class="mono">{{ addressList(i) }}</dd>
                <template v-if="i.description">
                  <dt>Description</dt>
                  <dd>{{ i.description }}</dd>
                </template>
                <template v-if="i.mac">
                  <dt>Hardware address</dt>
                  <dd class="mono">{{ i.mac }}</dd>
                </template>
                <template v-if="i.type && i.type !== 'PHYSICAL'">
                  <dt>Type</dt>
                  <dd>{{ i.type === 'BRIDGE' ? 'Bridge' : i.type === 'LINK_AGGREGATION' ? 'Bond' : i.type.toLowerCase() }}</dd>
                </template>
              </dl>
              <p v-if="!i.editable" class="small muted">Bridges and bonds can be changed in the TrueNAS web interface.</p>
            </li>
          </ul>
        </div>

        <div class="stack" style="--gap: 10px">
          <div class="row wrap" style="--gap: 8px">
            <h3>VLANs</h3>
            <span class="badge">Advanced</span>
            <span class="spacer" />
            <button class="btn small" :disabled="locked" @click="vlanOpen = true"><Plus :size="14" /> Add VLAN</button>
          </div>
          <p class="muted small">Separate virtual networks over the same cable. Only needed if your switch or router uses them.</p>
          <p v-if="!vlans.length" class="small muted">No VLANs.</p>
          <ul v-else class="ifaces">
            <li v-for="i in vlans" :key="i.name" class="card flat stack" style="--gap: 8px">
              <div class="row wrap" style="--gap: 8px">
                <Layers :size="16" class="muted" aria-hidden="true" />
                <strong class="mono">{{ i.name }}</strong>
                <span class="small muted">{{ vlanLine(i) }}</span>
                <span v-if="!i.applied" class="badge warn">Not applied</span>
                <span v-else class="badge" :class="i.linkUp ? 'ok' : ''">{{ i.linkUp ? 'Up' : 'Down' }}</span>
                <span v-if="i.usedByApexOs" class="badge info">ApexOs connects here</span>
                <span class="spacer" />
                <span class="row" style="--gap: 6px">
                  <button class="btn small" :disabled="locked" :aria-label="`Edit ${i.name}`" @click="editing = i"><Pencil :size="14" /> Edit</button>
                  <button class="btn small danger" :disabled="locked" :aria-label="`Remove ${i.name}`" @click="askRemove(i)">
                    <Trash2 :size="14" /> Remove
                  </button>
                </span>
              </div>
              <dl class="facts small">
                <template v-if="i.description">
                  <dt>Description</dt>
                  <dd>{{ i.description }}</dd>
                </template>
                <dt>Address setup</dt>
                <dd>{{ modeLabel(i.mode) }}</dd>
                <dt>IP addresses</dt>
                <dd class="mono">{{ addressList(i) }}</dd>
              </dl>
            </li>
          </ul>
        </div>

        <p class="small muted">
          Tip: if you use your server a lot from other devices, ask your router to always give it the same IP address (often called a DHCP
          reservation). That’s usually simpler than a fixed address.
        </p>
      </template>
    </PageState>
  </section>

  <NetworkInterfaceDialog v-if="editing && info" :iface="editing" :settings="info" @close="closeDialog" />
  <NetworkDnsDialog v-if="dnsOpen && info" :settings="info" @close="closeDialog" />
  <NetworkVlanDialog v-if="vlanOpen && info" :settings="info" @close="closeDialog" />
  <ConfirmDialog
    v-if="removing"
    :title="`Remove ${removing.name}?`"
    :message="`The server stops using ${vlanLine(removing)}${removing.liveAddresses.length ? ` and its address ${removing.liveAddresses[0]!.address}` : ''}. Devices on that VLAN can’t reach the server through it anymore.`"
    action-label="Remove VLAN"
    danger
    :busy="removeBusy"
    :error="removeError"
    @confirm="confirmRemove"
    @close="removing = null"
  />
</template>

<style scoped>
.facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 16px;
  margin: 0;
}
.facts dt {
  color: var(--text-muted);
}
.facts dd {
  margin: 0;
  overflow-wrap: anywhere;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
}
.change-name {
  margin-left: 2px;
}
.ifaces {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ifaces .card {
  padding: 14px 16px;
}
.recent {
  position: relative;
  padding: 14px 40px 14px 16px;
}
.dismiss {
  position: absolute;
  top: 8px;
  right: 8px;
  padding: 4px 6px;
}
@media (max-width: 480px) {
  .facts {
    grid-template-columns: 1fr;
    gap: 2px;
  }
  .facts dd {
    margin-bottom: 6px;
  }
}
</style>
