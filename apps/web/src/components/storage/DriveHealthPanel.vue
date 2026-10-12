<script setup lang="ts">
/**
 * A drive's health: what ApexOs is doing about its errors, plain-language guidance for a diagnosis,
 * the drive's own self-check (SMART) with "Check health now", and the history of error episodes.
 */
import { computed, onMounted, ref } from 'vue';
import { Activity, CircleAlert, CircleCheck, Eye, Replace, ShieldAlert } from 'lucide-vue-next';
import type { Drive, DriveHealthDetail, SmartSummary } from '@apexos/api-types';
import Modal from '../Modal.vue';
import { ApiError, api } from '../../lib/api.ts';
import { onServerChange } from '../../lib/events.ts';
import { formatRelative, formatTemperature } from '../../lib/format.ts';
import { driveTitle } from './drives.ts';
import { DIAGNOSIS_GUIDE, eventTone, formatDay, formatMoment, formatPowerOn } from './driveHealth.ts';

const props = defineProps<{
  drive: Drive;
  /** Pool display name. */
  poolName: string;
  /** Offer "Replace this drive" when the diagnosis is to replace it. */
  canReplace?: boolean;
}>();
const emit = defineEmits<{ close: []; replace: [] }>();

const detail = ref<DriveHealthDetail | null>(null);
const loadError = ref<string | null>(null);
const smartBusy = ref(false);
const smartError = ref<string | null>(null);
const showAll = ref(false);
const SHOWN_EVENTS = 8;

const base = computed(() => `/storage/drives/${encodeURIComponent(props.drive.identifier)}`);

async function load() {
  try {
    detail.value = await api.get<DriveHealthDetail>(`${base.value}/health`);
    loadError.value = null;
  } catch (e) {
    if (!detail.value) loadError.value = e instanceof ApiError ? e.message : String(e);
  }
}

onMounted(load);
onServerChange(['storage'], load);

async function checkNow() {
  smartBusy.value = true;
  smartError.value = null;
  try {
    await api.post<SmartSummary>(`${base.value}/smart`);
    await load();
  } catch (e) {
    smartError.value = e instanceof ApiError ? e.message : String(e);
  } finally {
    smartBusy.value = false;
  }
}

const health = computed(() => detail.value?.health ?? props.drive.health ?? null);
const guide = computed(() => (health.value?.state === 'attention' ? DIAGNOSIS_GUIDE[health.value.diagnosis ?? 'unclear'] : null));
const errors = computed(() => detail.value?.errors ?? props.drive.errors);
const errorTotal = computed(() => errors.value.read + errors.value.write + errors.value.checksum);
const smart = computed(() => detail.value?.smart ?? null);
const events = computed(() => {
  const all = detail.value?.events ?? [];
  return showAll.value ? all : all.slice(0, SHOWN_EVENTS);
});
const hiddenEvents = computed(() => Math.max(0, (detail.value?.events.length ?? 0) - SHOWN_EVENTS));
const interval = computed(() => {
  const m = detail.value?.checkIntervalMinutes ?? 10;
  return m === 1 ? 'every minute' : `every ${m} minutes`;
});

/** Headline for states other than "attention" (which shows its guide instead). */
const status = computed(() => {
  const h = health.value;
  if (h?.state === 'checking') {
    return {
      cls: 'info',
      icon: Activity,
      title: 'Checking the pool',
      text: 'This drive reported errors. ApexOs is checking the pool to find and repair any damaged data. On large pools this can take several hours; the pool stays usable.',
    };
  }
  if (h?.state === 'watching') {
    return {
      cls: 'info',
      icon: Eye,
      title: h.watchUntil ? `Watching until ${formatDay(h.watchUntil)}` : 'Watching',
      text: 'A few errors were repaired and nothing was lost. ApexOs reset the error count and keeps an eye on this drive. If errors come back before then, you’ll get a notice with what to do.',
    };
  }
  if (errorTotal.value > 0) {
    return {
      cls: 'warn',
      icon: CircleAlert,
      title: 'Errors reported',
      text: `The drive’s error count isn’t zero. ApexOs looks at error counts ${interval.value} and whenever the pool changes, and acts on new errors.`,
    };
  }
  return {
    cls: 'ok',
    icon: CircleCheck,
    title: 'No problems',
    text: `ApexOs looks at this drive’s error counts ${interval.value} and whenever the pool changes. If errors appear, it checks the pool and repairs what it can.`,
  };
});

const smartRows = computed(() => {
  const s = smart.value;
  if (!s) return [];
  const rows: { label: string; value: string; bad?: boolean }[] = [];
  rows.push({ label: 'Overall', value: s.passed === null ? 'Not reported' : s.passed ? 'Passed' : 'Failing', bad: s.passed === false });
  if (s.reallocatedSectors !== null) rows.push({ label: 'Replaced sectors', value: String(s.reallocatedSectors), bad: s.reallocatedSectors > 0 });
  if (s.pendingSectors !== null) rows.push({ label: 'Unstable sectors', value: String(s.pendingSectors), bad: s.pendingSectors > 0 });
  if (s.offlineUncorrectable !== null) rows.push({ label: 'Unreadable sectors', value: String(s.offlineUncorrectable), bad: s.offlineUncorrectable > 0 });
  if (s.mediaErrors !== null) rows.push({ label: 'Media errors', value: String(s.mediaErrors), bad: s.mediaErrors > 0 });
  if (s.powerOnHours !== null) rows.push({ label: 'Powered on for', value: formatPowerOn(s.powerOnHours) });
  if (s.temperatureC !== null) rows.push({ label: 'Temperature', value: formatTemperature(s.temperatureC) });
  return rows;
});
const smartVerdict = computed(() => {
  const s = smart.value;
  if (!s) return null;
  if (s.damaged) return { cls: 'err', text: 'The drive reports damaged areas. Plan to replace it.' };
  if (s.passed === false) return { cls: 'err', text: 'The drive rates its own health as failing. Plan to replace it.' };
  return { cls: 'ok', text: 'No damaged areas reported.' };
});
</script>

<template>
  <Modal :title="`Health of ${driveTitle(drive)}`" wide @close="emit('close')">
    <p class="small muted ident">
      <span>{{ poolName }}</span>
      <span>Serial <span class="mono">{{ drive.serial }}</span></span>
    </p>

    <p v-if="loadError" class="callout err">{{ loadError }}</p>

    <!-- What is going on, and what to do -->
    <section v-if="guide" class="callout guide" :class="guide.cls" aria-labelledby="dh-guide-title">
      <div class="row" style="--gap: 8px">
        <ShieldAlert :size="18" aria-hidden="true" class="guide-icon" />
        <h3 id="dh-guide-title">{{ guide.title }}</h3>
      </div>
      <p v-if="detail?.diagnosisNote">{{ detail.diagnosisNote }} {{ guide.why }}</p>
      <p v-else>{{ guide.summary }}</p>
      <ol class="steps">
        <li v-for="step in guide.steps" :key="step">{{ step }}</li>
      </ol>
      <div v-if="health?.diagnosis === 'replace-drive' && canReplace" class="row">
        <button class="btn small" @click="emit('replace')"><Replace :size="15" aria-hidden="true" /> Replace this drive</button>
      </div>
      <p class="small muted">Dismissing the notice doesn’t stop ApexOs from watching this drive.</p>
    </section>
    <section v-else class="status" :class="status.cls" aria-live="polite">
      <component :is="status.icon" :size="20" aria-hidden="true" class="status-icon" />
      <div class="stack" style="--gap: 2px">
        <strong>{{ status.title }}</strong>
        <span class="small">{{ status.text }}</span>
      </div>
    </section>

    <p class="small">
      <span class="muted">Current error count:</span>
      {{ errors.read }} read · {{ errors.write }} write · {{ errors.checksum }} checksum
    </p>

    <!-- The drive's own self-check -->
    <section class="stack" style="--gap: 10px" aria-labelledby="dh-smart-title">
      <div class="row wrap" style="--gap: 8px 12px">
        <h3 id="dh-smart-title">Drive self-check (SMART)</h3>
        <span class="spacer" />
        <button class="btn small" :disabled="smartBusy" :aria-busy="smartBusy" @click="checkNow">
          <span v-if="smartBusy" class="spin" aria-hidden="true" />
          {{ smartBusy ? 'Checking…' : 'Check health now' }}
        </button>
      </div>
      <div aria-live="polite" class="stack" style="--gap: 8px">
        <p v-if="smartBusy" class="small muted">Asking the drive. This takes a few seconds.</p>
        <p v-if="smartError" class="callout err small">{{ smartError }}</p>
        <template v-if="smart">
          <p v-if="smartVerdict" class="small verdict" :class="smartVerdict.cls">{{ smartVerdict.text }}</p>
          <dl class="facts small">
            <div v-for="row in smartRows" :key="row.label" :class="{ bad: row.bad }">
              <dt>{{ row.label }}</dt>
              <dd>{{ row.value }}</dd>
            </div>
          </dl>
          <p class="small muted">Read {{ formatRelative(smart.readAt) }}.</p>
        </template>
        <p v-else-if="!smartBusy && detail" class="small muted">Not read yet. ApexOs reads it automatically when the drive reports errors.</p>
      </div>
    </section>

    <!-- History -->
    <section class="stack" style="--gap: 10px" aria-labelledby="dh-history-title">
      <h3 id="dh-history-title">History</h3>
      <p v-if="detail && !detail.events.length" class="small muted">No errors so far.</p>
      <ol v-else class="timeline">
        <li v-for="(e, i) in events" :key="`${e.time}-${i}`" :class="eventTone(e.kind)">
          <time class="small muted" :datetime="e.time">{{ formatMoment(e.time) }}</time>
          <span class="small">{{ e.message }}</span>
        </li>
      </ol>
      <button v-if="hiddenEvents && !showAll" class="btn ghost small more" @click="showAll = true">Show {{ hiddenEvents }} older</button>
    </section>

    <template #footer>
      <button class="btn primary" @click="emit('close')">Done</button>
    </template>
  </Modal>
</template>

<style scoped>
h3 {
  font-size: 1rem;
  margin: 0;
}
.ident {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  margin-top: -8px;
}
.guide {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.guide p {
  margin: 0;
}
.guide-icon {
  flex: none;
  color: var(--warn);
}
.guide.err .guide-icon {
  color: var(--err);
}
.steps {
  margin: 0;
  padding-left: 1.3em;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.status {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 12px 14px;
}
.status-icon {
  flex: none;
  margin-top: 1px;
}
.status.ok .status-icon {
  color: var(--ok);
}
.status.info .status-icon {
  color: var(--info);
}
.status.warn .status-icon {
  color: var(--warn);
}
.verdict {
  margin: 0;
  font-weight: 600;
}
.verdict.ok {
  color: var(--ok);
}
.verdict.err {
  color: var(--err);
}
.facts {
  margin: 0;
  display: grid;
  gap: 6px 16px;
  grid-template-columns: repeat(auto-fill, minmax(min(150px, 100%), 1fr));
}
.facts div {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 6px 10px;
  background: var(--surface-2);
}
.facts dt {
  color: var(--text-muted);
}
.facts dd {
  margin: 0;
  font-weight: 600;
}
.facts div.bad {
  border-color: var(--err);
  background: var(--err-soft);
}
.facts div.bad dd {
  color: var(--err);
}
.timeline {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.timeline li {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 0 0 12px 20px;
  border-left: 2px solid var(--border);
  margin-left: 5px;
  overflow-wrap: anywhere;
}
.timeline li:last-child {
  border-left-color: transparent;
  padding-bottom: 0;
}
.timeline li::before {
  content: '';
  position: absolute;
  left: -7px;
  top: 3px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--info);
  border: 2px solid var(--surface);
}
.timeline li.ok::before {
  background: var(--ok);
}
.timeline li.warn::before {
  background: var(--warn);
}
.timeline li.err::before {
  background: var(--err);
}
.more {
  align-self: flex-start;
}
</style>
