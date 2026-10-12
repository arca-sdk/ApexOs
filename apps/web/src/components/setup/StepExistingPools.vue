<script setup lang="ts">
/**
 * Step 3: pools already on the drives. Local pools default to "keep", pools from another system
 * default to "import". Leaving one out needs a checkbox confirmation (nothing is erased yet).
 */
import { computed, ref } from 'vue';
import { AppWindow, Folder, Users } from 'lucide-vue-next';
import type { Drive, ExistingPoolSummary, ImportablePool } from '@hearth/api-types';
import ConfirmDialog from '../ConfirmDialog.vue';
import HealthBadge from '../HealthBadge.vue';
import DriveRow from '../storage/DriveRow.vue';
import ToggleSwitch from './ToggleSwitch.vue';
import { formatBytes, toleranceText } from '../../lib/format.ts';
import { useWizard } from './wizard.ts';

const wizard = useWizard();
const { state } = wizard;

const pending = ref<{ kind: 'keep'; pool: ExistingPoolSummary } | { kind: 'import'; pool: ImportablePool } | null>(null);

function drivesOf(ids: string[]): Drive[] {
  return ids.map((id) => state.info?.drives.find((d) => d.identifier === id)).filter((d): d is Drive => Boolean(d));
}
function foreignDrives(pool: ImportablePool): Drive[] {
  return (state.info?.drives ?? []).filter((d) => d.exportedPool === pool.name);
}

function setKeep(pool: ExistingPoolSummary, on: boolean) {
  if (on) state.keep[pool.name] = true;
  else pending.value = { kind: 'keep', pool };
}
function setImport(pool: ImportablePool, on: boolean) {
  if (on) state.importSel[pool.guid] = true;
  else pending.value = { kind: 'import', pool };
}
function confirmLeaveOut() {
  const p = pending.value;
  if (!p) return;
  if (p.kind === 'keep') state.keep[p.pool.name] = false;
  else state.importSel[p.pool.guid] = false;
  pending.value = null;
}

const confirmTitle = computed(() => {
  const p = pending.value;
  if (!p) return '';
  return p.kind === 'keep' ? `Let go of ${p.pool.displayName}?` : `Leave ${p.pool.name} out?`;
});
const confirmMessage = computed(() => {
  const p = pending.value;
  if (!p) return '';
  if (p.kind === 'keep') {
    const extras = [p.pool.folders.length ? 'folders' : '', p.pool.apps.length ? 'apps' : ''].filter(Boolean).join(' and ');
    return `Its drives become free for new pools. If a new pool uses any of them, all of ${p.pool.displayName} is erased when you finish setup${extras ? `, including its ${extras}` : ''}. If you don’t reuse its drives, it stays on them untouched. Nothing is erased yet.`;
  }
  return `It won’t be brought into this server. If a new pool uses any of its drives, ${p.pool.name} is erased when you finish setup; otherwise it stays on its drives untouched. Nothing is erased yet.`;
});
const confirmCheckbox = computed(() => {
  const p = pending.value;
  if (!p) return '';
  return `I understand that ${p.kind === 'keep' ? p.pool.displayName : p.pool.name} can be erased if I reuse its drives.`;
});

const otherUsers = computed(() => state.info?.serverUsers ?? []);
</script>

<template>
  <div class="stack" style="--gap: 24px">
    <section v-if="wizard.existingPools.value.length" class="stack" style="--gap: 12px" aria-labelledby="local-pools">
      <h3 id="local-pools">On this server</h3>
      <article v-for="pool in wizard.existingPools.value" :key="pool.name" class="card pool" :class="{ off: !state.keep[pool.name] }">
        <div class="row wrap head" style="--gap: 10px">
          <h4>{{ pool.displayName }}</h4>
          <HealthBadge :health="pool.health" />
          <span class="spacer" />
          <ToggleSwitch :checked="Boolean(state.keep[pool.name])" :label="`Keep ${pool.displayName}`" @toggle="(on) => setKeep(pool, on)" />
        </div>
        <p class="small" :class="state.keep[pool.name] ? 'muted' : 'warn-text'">
          {{
            state.keep[pool.name]
              ? 'Will be kept exactly as it is, with everything on it.'
              : 'Not kept: its drives can be reused for new pools. Nothing is erased yet.'
          }}
        </p>
        <div class="facts small">
          <span><span class="muted">Used</span> {{ formatBytes(pool.usedBytes) }} of {{ formatBytes(pool.sizeBytes) }}</span>
          <span><span class="muted">Layout</span> {{ pool.layoutLabel }}</span>
          <span><span class="muted">Protection</span> {{ toleranceText(pool.faultTolerance) }}</span>
        </div>
        <div class="meter" :class="{ warn: pool.sizeBytes > 0 && pool.usedBytes / pool.sizeBytes > 0.8 }" aria-hidden="true">
          <span :style="{ width: `${pool.sizeBytes ? Math.min(100, (pool.usedBytes / pool.sizeBytes) * 100) : 0}%` }" />
        </div>
        <p v-if="pool.health !== 'healthy'" class="callout warn small">
          This pool isn’t healthy ({{ pool.health }}). If you keep it, check it on the Storage page after setup.
        </p>
        <div class="contents small">
          <div class="row wrap" style="--gap: 6px">
            <Folder :size="15" aria-hidden="true" class="muted" />
            <span class="muted">Folders:</span>
            <template v-if="pool.folders.length"><span v-for="f in pool.folders" :key="f" class="chip">{{ f }}</span></template>
            <span v-else class="muted">none</span>
          </div>
          <div class="row wrap" style="--gap: 6px">
            <AppWindow :size="15" aria-hidden="true" class="muted" />
            <span class="muted">Apps:</span>
            <template v-if="pool.apps.length"><span v-for="a in pool.apps" :key="a" class="chip">{{ a }}</span></template>
            <span v-else class="muted">none run from this pool</span>
          </div>
        </div>
        <details>
          <summary class="small">{{ pool.drives.length }} {{ pool.drives.length === 1 ? 'drive' : 'drives' }}</summary>
          <ul class="drives">
            <li v-for="d in drivesOf(pool.drives)" :key="d.identifier"><DriveRow :drive="d" :show-warnings="false" /></li>
          </ul>
        </details>
      </article>
    </section>

    <section class="stack" style="--gap: 12px" aria-labelledby="foreign-pools">
      <h3 id="foreign-pools">From another system</h3>
      <div v-if="state.importable.status === 'loading' || state.importable.status === 'idle'" class="card row muted" role="status">
        <span class="spin" /> Looking for pools on your drives. This can take a minute…
      </div>
      <div v-else-if="state.importable.status === 'error'" class="callout err stack" style="--gap: 8px" role="alert">
        <span>Hearth couldn’t check your drives for other pools: {{ state.importable.error }}</span>
        <span class="small">To keep you from erasing something by accident, you can only continue once this check works.</span>
        <div><button class="btn small" @click="wizard.loadImportable(true)">Try again</button></div>
      </div>
      <p v-else-if="!state.importable.pools.length && wizard.existingPools.value.length" class="small muted">No pools from other systems were found on your drives.</p>
      <div v-else-if="!state.importable.pools.length" class="card flat stack" style="--gap: 4px">
        <strong>No existing pools found</strong>
        <span class="small muted">Your drives don’t hold any pools, so there’s nothing to keep. Continue to set up new storage.</span>
      </div>
      <template v-else>
      <article v-for="pool in state.importable.pools" :key="pool.guid" class="card pool" :class="{ off: !state.importSel[pool.guid] }">
        <div class="row wrap head" style="--gap: 10px">
          <h4>{{ pool.name }}</h4>
          <span class="badge" :class="pool.status === 'ONLINE' ? 'ok' : 'warn'">{{ pool.status === 'ONLINE' ? 'All drives found' : pool.status.toLowerCase() }}</span>
          <span class="spacer" />
          <ToggleSwitch :checked="Boolean(state.importSel[pool.guid])" :label="`Import ${pool.name}`" @toggle="(on) => setImport(pool, on)" />
        </div>
        <p class="small muted">{{ pool.hostname ? `Previously used on ${pool.hostname}.` : 'Previously used on another system.' }}</p>
        <p class="small" :class="state.importSel[pool.guid] ? 'muted' : 'warn-text'">
          {{
            state.importSel[pool.guid]
              ? 'Will be imported with everything on it: folders, files and app data.'
              : 'Not imported: its drives can be reused for new pools. Nothing is erased yet.'
          }}
        </p>
        <details v-if="foreignDrives(pool).length">
          <summary class="small">{{ foreignDrives(pool).length }} {{ foreignDrives(pool).length === 1 ? 'drive' : 'drives' }}</summary>
          <ul class="drives">
            <li v-for="d in foreignDrives(pool)" :key="d.identifier"><DriveRow :drive="d" :show-warnings="false" /></li>
          </ul>
        </details>
      </article>
      </template>
    </section>

    <section v-if="otherUsers.length" class="card flat stack also" style="--gap: 6px">
      <div class="row" style="--gap: 8px"><Users :size="16" aria-hidden="true" /> <strong>Also on this server, whatever you choose</strong></div>
      <p class="small muted">
        Users belong to the server, not to a pool, so they stay: {{ otherUsers.join(', ') }}.
      </p>
    </section>
  </div>

  <ConfirmDialog
    v-if="pending"
    :title="confirmTitle"
    :message="confirmMessage"
    :checkbox="confirmCheckbox"
    :action-label="pending.kind === 'keep' ? 'Don’t keep it' : 'Don’t import it'"
    @confirm="confirmLeaveOut"
    @close="pending = null"
  />
</template>

<style scoped>
h3 {
  font-size: 0.82rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
}
h4 {
  font-size: 1.05rem;
  overflow-wrap: anywhere;
}
.pool {
  display: flex;
  flex-direction: column;
  gap: 10px;
  transition: opacity 0.15s;
}
.pool.off {
  background: var(--surface-2);
  box-shadow: none;
}
.head {
  align-items: center;
}
.facts {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 18px;
}
.contents {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.chip {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0 8px;
}
.pool.off .chip {
  background: var(--surface);
}
.warn-text {
  color: var(--warn);
  font-weight: 550;
}
details summary {
  cursor: pointer;
  color: var(--text-muted);
}
.drives {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.drives li {
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
}
.also {
  background: var(--surface-2);
}
</style>
