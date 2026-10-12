<script setup lang="ts">
/** Step 2: the four hardware scan cards; each opens a side panel with its checks and facts. */
import { computed, ref } from 'vue';
import { Boxes, ChevronRight, CircleAlert, CircleCheck, CircleHelp, HardDrive, Info, Monitor, Server, TriangleAlert } from 'lucide-vue-next';
import type { ScanCard, ScanCardId, ScanCheck, ScanStatus } from '@hearth/api-types';
import SidePanel from './SidePanel.vue';
import DriveRow from '../storage/DriveRow.vue';
import { formatMemory } from '../../lib/format.ts';
import { useWizard } from './wizard.ts';

const { state } = useWizard();
const scan = computed(() => state.info?.scan ?? null);
const openId = ref<ScanCardId | null>(null);
const openCard = computed(() => scan.value?.cards.find((c) => c.id === openId.value) ?? null);

const ICONS = { system: Server, storage: HardDrive, apps: Boxes, virtualization: Monitor } as const;
const STATUS: Record<ScanStatus, { cls: string; icon: typeof CircleCheck }> = {
  ok: { cls: 'ok', icon: CircleCheck },
  attention: { cls: 'warn', icon: TriangleAlert },
  issues: { cls: 'err', icon: CircleAlert },
  unavailable: { cls: 'muted', icon: CircleHelp },
};
const SEVERITY: Record<ScanCheck['severity'], { cls: string; icon: typeof CircleCheck; label: string }> = {
  error: { cls: 'err', icon: CircleAlert, label: 'Problem' },
  warning: { cls: 'warn', icon: TriangleAlert, label: 'Needs attention' },
  info: { cls: 'info', icon: Info, label: 'Good to know' },
};
const ORDER: Record<ScanCheck['severity'], number> = { error: 0, warning: 1, info: 2 };

function sortedChecks(card: ScanCard): ScanCheck[] {
  return [...card.checks].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
}

const errors = computed(() => (scan.value?.cards ?? []).flatMap((c) => c.checks.filter((k) => k.severity === 'error').map((k) => ({ card: c, check: k }))));
const system = computed(() => scan.value?.system ?? null);
</script>

<template>
  <div v-if="scan" class="stack" style="--gap: 16px">
    <div v-if="errors.length" class="callout err stack" style="--gap: 6px" role="alert">
      <strong>{{ errors.length === 1 ? 'One problem needs' : `${errors.length} problems need` }} your attention</strong>
      <ul class="error-list">
        <li v-for="e in errors" :key="e.check.id">
          <button type="button" class="linkish" @click="openId = e.card.id">{{ e.check.title }}</button>
        </li>
      </ul>
      <span class="small">You can still continue, but fix these before you rely on this server.</span>
    </div>

    <p v-if="system" class="small muted">
      {{ [system.manufacturer, system.product].filter(Boolean).join(' ') || 'Your server' }} · {{ system.cpuModel }} · {{ formatMemory(system.memoryBytes) }} memory · TrueNAS
      {{ system.version }}
    </p>

    <div class="cards">
      <button v-for="card in scan.cards" :key="card.id" type="button" class="card scan-card" :class="STATUS[card.status].cls" @click="openId = card.id">
        <component :is="ICONS[card.id]" :size="24" class="kind" aria-hidden="true" />
        <span class="text">
          <strong>{{ card.title }}</strong>
          <span class="status small">
            <component :is="STATUS[card.status].icon" :size="15" aria-hidden="true" />
            {{ card.summary }}
          </span>
        </span>
        <ChevronRight :size="18" class="chev" aria-hidden="true" />
      </button>
    </div>
  </div>

  <SidePanel v-if="openCard" :title="openCard.title" @close="openId = null">
    <p class="status-line" :class="STATUS[openCard.status].cls">
      <component :is="STATUS[openCard.status].icon" :size="18" aria-hidden="true" />
      <strong>{{ openCard.summary }}</strong>
    </p>
    <p v-if="openCard.status === 'unavailable'" class="small muted">Hearth couldn’t read these details from TrueNAS. This doesn’t block setup.</p>

    <section v-if="openCard.checks.length" class="stack" style="--gap: 10px">
      <h3>What we found</h3>
      <ul class="checks">
        <li v-for="c in sortedChecks(openCard)" :key="c.id" class="check" :class="SEVERITY[c.severity].cls">
          <component :is="SEVERITY[c.severity].icon" :size="18" class="sev-icon" aria-hidden="true" />
          <div class="stack" style="--gap: 2px">
            <span class="sr-only">{{ SEVERITY[c.severity].label }}:</span>
            <strong>{{ c.title }}</strong>
            <span class="small">{{ c.detail }}</span>
          </div>
        </li>
      </ul>
    </section>
    <p v-else class="small muted">Everything we checked looks fine.</p>

    <section v-if="openCard.facts.length" class="stack" style="--gap: 8px">
      <h3>Details</h3>
      <dl class="facts">
        <div v-for="f in openCard.facts" :key="f.label">
          <dt class="muted">{{ f.label }}</dt>
          <dd>{{ f.value }}</dd>
        </div>
      </dl>
    </section>

    <section v-if="openCard.id === 'storage' && state.info?.drives.length" class="stack" style="--gap: 8px">
      <h3>Drives</h3>
      <ul class="drives">
        <li v-for="d in state.info.drives" :key="d.identifier">
          <DriveRow :drive="d" show-temp>
            <template #note>
              <span v-if="d.pool" class="small muted">In the pool {{ d.pool }}</span>
              <span v-else-if="!d.available" class="small muted">{{ d.unavailableReason }}</span>
            </template>
          </DriveRow>
        </li>
      </ul>
    </section>
  </SidePanel>
</template>

<style scoped>
.cards {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(auto-fill, minmax(min(240px, 100%), 1fr));
}
.scan-card {
  appearance: none;
  font: inherit;
  color: var(--text);
  text-align: left;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 18px;
  border-left: 4px solid var(--border);
}
.scan-card:hover {
  border-color: var(--accent);
}
.scan-card:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.scan-card.ok {
  border-left-color: var(--ok);
}
.scan-card.warn {
  border-left-color: var(--warn);
}
.scan-card.err {
  border-left-color: var(--err);
}
.kind {
  color: var(--text-muted);
  flex: none;
}
.text {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.ok .status,
.status-line.ok {
  color: var(--ok);
}
.warn .status,
.status-line.warn {
  color: var(--warn);
}
.err .status,
.status-line.err {
  color: var(--err);
}
.muted .status,
.status-line.muted {
  color: var(--text-muted);
}
.chev {
  color: var(--text-muted);
  flex: none;
}
.status-line {
  display: flex;
  align-items: center;
  gap: 8px;
}
.error-list {
  margin: 0;
  padding-left: 18px;
}
.linkish {
  appearance: none;
  border: 0;
  background: none;
  padding: 0;
  font: inherit;
  color: inherit;
  text-decoration: underline;
  cursor: pointer;
  text-align: left;
}
.checks,
.drives {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.check {
  display: flex;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  border-left: 3px solid var(--info);
  background: var(--info-soft);
}
.check.err {
  border-color: var(--err);
  background: var(--err-soft);
}
.check.warn {
  border-color: var(--warn);
  background: var(--warn-soft);
}
.sev-icon {
  flex: none;
  margin-top: 2px;
}
.check.err .sev-icon {
  color: var(--err);
}
.check.warn .sev-icon {
  color: var(--warn);
}
.check.info .sev-icon {
  color: var(--info);
}
.facts {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.facts div {
  display: grid;
  grid-template-columns: 120px 1fr;
  gap: 10px;
}
.facts dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.drives li {
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
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
