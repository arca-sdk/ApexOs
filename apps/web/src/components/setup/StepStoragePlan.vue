<script setup lang="ts">
/**
 * Step 4b: the storage plan. Recommended mode starts from the server's suggestion; Custom starts
 * empty. Pools can be added, edited (same Add pool dialog as the Storage page), renamed and removed.
 */
import { computed, ref } from 'vue';
import { Archive, Pencil, Plus, ShieldAlert, ShieldCheck, SquarePen, Trash2 } from 'lucide-vue-next';
import type { LayoutEstimate, NewPoolSpec } from '@hearth/api-types';
import Modal from '../Modal.vue';
import HealthBadge from '../HealthBadge.vue';
import AddPoolDialog from '../storage/AddPoolDialog.vue';
import DriveRow from '../storage/DriveRow.vue';
import { layoutTitle, poolNameProblem } from '../storage/drives.ts';
import { formatBytes, toleranceText } from '../../lib/format.ts';
import { useWizard, type PlannedNewPool } from './wizard.ts';

const wizard = useWizard();
const { state } = wizard;

const editing = ref<{ index: number | null } | null>(null);
const renaming = ref<{ index: number; name: string; touched: boolean } | null>(null);

const driveById = computed(() => new Map((state.info?.drives ?? []).map((d) => [d.identifier, d])));
function drivesOf(p: PlannedNewPool) {
  return p.drives.map((id) => driveById.value.get(id)).filter((d) => d !== undefined);
}
function namesExcept(index: number | null): string[] {
  // Pools the user let go keep their name unless a planned pool reuses (and so erases) their drives.
  const reused = new Set(state.newPools.flatMap((p) => p.drives));
  const untouched = wizard.letGoNames.value.filter(
    (name) => !(state.info?.drives ?? []).some((d) => d.pool === name && reused.has(d.identifier)),
  );
  return [...wizard.takenNames.value, ...untouched, ...state.newPools.filter((_, i) => i !== index).map((p) => p.name)];
}

const editInitial = computed<NewPoolSpec | null>(() => {
  const i = editing.value?.index;
  if (i === null || i === undefined) return null;
  const p = state.newPools[i];
  return p ? { name: p.name, layout: p.layout, drives: [...p.drives] } : null;
});
const editPickers = computed(() => wizard.pickerDrives(editInitial.value?.name));

function saveEdit(spec: NewPoolSpec, estimate: LayoutEstimate) {
  const i = editing.value?.index ?? null;
  const before = i === null ? null : state.newPools[i];
  const changed = !before || before.layout !== spec.layout || before.drives.join() !== spec.drives.join();
  const pool: PlannedNewPool = {
    ...spec,
    usableBytes: estimate.usableBytes,
    faultTolerance: estimate.faultTolerance,
    reason: changed ? null : (before?.reason ?? null),
    warnings: estimate.warnings,
  };
  if (i === null) state.newPools.push(pool);
  else state.newPools.splice(i, 1, pool);
  editing.value = null;
}

function remove(index: number) {
  state.newPools.splice(index, 1);
}

const renameProblem = computed(() => (renaming.value ? poolNameProblem(renaming.value.name, namesExcept(renaming.value.index)) : null));
function saveRename() {
  const r = renaming.value;
  if (!r) return;
  r.touched = true;
  if (renameProblem.value) return;
  const p = state.newPools[r.index];
  if (p) p.name = r.name.trim();
  renaming.value = null;
}

const leftover = computed(() => wizard.unassignedCandidates.value);
function leftoverReason(id: string): string {
  return state.planUnassigned[id] ?? 'Not in any pool yet. You can add it to a pool now, or later from the Storage page.';
}

const keptCount = computed(() => wizard.keptPools.value.length + wizard.importing.value.length);
</script>

<template>
  <div class="stack" style="--gap: 24px">
    <div v-if="state.planLoading" class="card row muted" role="status"><span class="spin" /> Working out the best layout for your drives…</div>
    <div v-else-if="state.planError" class="callout err stack" style="--gap: 8px" role="alert">
      <span>Hearth couldn’t work out a plan: {{ state.planError }}</span>
      <div><button class="btn small" @click="wizard.ensurePlan()">Try again</button></div>
    </div>

    <template v-else>
      <section class="stack" style="--gap: 12px" aria-labelledby="new-pools">
        <div class="row wrap" style="--gap: 10px">
          <h3 id="new-pools">New pools</h3>
          <span class="spacer" />
          <button class="btn small" :disabled="!leftover.length" :title="leftover.length ? undefined : 'Every free drive is already in a pool.'" @click="editing = { index: null }">
            <Plus :size="15" aria-hidden="true" /> Add pool
          </button>
        </div>

        <div v-if="!state.newPools.length" class="card flat empty stack" style="--gap: 6px">
          <strong>No new pools yet</strong>
          <span class="small muted">
            {{ leftover.length ? 'Use Add pool to choose drives and a layout.' : 'There are no free drives left to build a pool from.' }}
          </span>
        </div>

        <article v-for="(p, i) in state.newPools" :key="p.name + i" class="card planned stack" style="--gap: 10px" :aria-label="`Planned pool ${p.name}`">
          <div class="row wrap" style="--gap: 8px">
            <h4>{{ p.name }}</h4>
            <span class="badge accent">New</span>
            <span class="spacer" />
            <div class="row actions" style="--gap: 4px">
              <button class="btn ghost small" :aria-label="`Rename ${p.name}`" @click="renaming = { index: i, name: p.name, touched: false }">
                <Pencil :size="15" aria-hidden="true" /> Rename
              </button>
              <button class="btn ghost small" :aria-label="`Edit ${p.name}`" @click="editing = { index: i }"><SquarePen :size="15" aria-hidden="true" /> Edit</button>
              <button class="btn ghost small danger" :aria-label="`Remove ${p.name}`" @click="remove(i)"><Trash2 :size="15" aria-hidden="true" /> Remove</button>
            </div>
          </div>
          <div class="stats">
            <div>
              <div class="small muted">Usable space</div>
              <strong>about {{ formatBytes(p.usableBytes) }}</strong>
            </div>
            <div>
              <div class="small muted">Layout</div>
              <strong>{{ layoutTitle(p.layout, p.drives.length) }}</strong>
            </div>
            <div>
              <div class="small muted">Drives</div>
              <strong>{{ p.drives.length }}</strong>
            </div>
            <div>
              <div class="small muted">Protection</div>
              <strong class="row" style="--gap: 6px" :class="{ weak: p.faultTolerance === 0 }">
                <ShieldCheck v-if="p.faultTolerance > 0" :size="16" aria-hidden="true" />
                <ShieldAlert v-else :size="16" aria-hidden="true" />
                {{ toleranceText(p.faultTolerance) }}
              </strong>
            </div>
          </div>
          <p v-if="p.reason" class="small muted">{{ p.reason }}</p>
          <p v-for="w in p.warnings" :key="w" class="callout warn small">{{ w }}</p>
          <details>
            <summary class="small">Show drives</summary>
            <ul class="drives">
              <li v-for="d in drivesOf(p)" :key="d.identifier">
                <DriveRow :drive="d">
                  <template #note>
                    <span v-if="wizard.driveNote(d)" class="small note">{{ wizard.driveNote(d) }}</span>
                  </template>
                </DriveRow>
              </li>
            </ul>
          </details>
        </article>
      </section>

      <section v-if="keptCount" class="stack" style="--gap: 10px" aria-labelledby="kept-pools">
        <h3 id="kept-pools">Pools you’re keeping</h3>
        <ul class="card flat kept">
          <li v-for="k in wizard.keptPools.value" :key="k.name" class="row wrap" style="--gap: 8px 12px">
            <Archive :size="16" aria-hidden="true" class="muted" />
            <strong>{{ k.displayName }}</strong>
            <span class="badge">Kept</span>
            <HealthBadge v-if="k.health !== 'healthy'" :health="k.health" />
            <span class="small muted">{{ formatBytes(k.usedBytes) }} used of {{ formatBytes(k.sizeBytes) }} · {{ toleranceText(k.faultTolerance) }}</span>
          </li>
          <li v-for="k in wizard.importing.value" :key="k.guid" class="row wrap" style="--gap: 8px 12px">
            <Archive :size="16" aria-hidden="true" class="muted" />
            <strong>{{ k.name }}</strong>
            <span class="badge info">Imported</span>
            <span class="small muted">{{ k.hostname ? `from ${k.hostname}` : 'from another system' }}</span>
          </li>
        </ul>
      </section>

      <section v-if="leftover.length" class="stack" style="--gap: 10px" aria-labelledby="unused">
        <h3 id="unused">Not used</h3>
        <ul class="card flat unused">
          <li v-for="d in leftover" :key="d.identifier">
            <DriveRow :drive="d">
              <template #note>
                <span class="small muted">{{ leftoverReason(d.identifier) }}</span>
              </template>
            </DriveRow>
          </li>
        </ul>
      </section>
    </template>
  </div>

  <AddPoolDialog
    v-if="editing"
    mode="plan"
    :drives="editPickers"
    :initial="editInitial"
    :taken-names="namesExcept(editing.index)"
    @save="saveEdit"
    @close="editing = null"
  />

  <Modal v-if="renaming" title="Rename pool" @close="renaming = null">
    <form id="rename-planned" class="field" @submit.prevent="saveRename">
      <label for="planned-name">Pool name</label>
      <input id="planned-name" v-model="renaming.name" type="text" autocomplete="off" :aria-invalid="Boolean(renaming.touched && renameProblem)" @blur="renaming.touched = true" />
      <span v-if="renaming.touched && renameProblem" class="error-text">{{ renameProblem }}</span>
      <span class="hint">Letters, numbers, dots, dashes or underscores, starting with a letter. This becomes the pool’s folder name on the server.</span>
    </form>
    <template #footer>
      <button class="btn" type="button" @click="renaming = null">Cancel</button>
      <button class="btn primary" type="submit" form="rename-planned" :disabled="Boolean(renameProblem)">Rename</button>
    </template>
  </Modal>
</template>

<style scoped>
h3 {
  font-size: 0.82rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
}
h4 {
  font-size: 1.1rem;
  overflow-wrap: anywhere;
}
.actions {
  flex-wrap: wrap;
}
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 12px;
  padding: 12px 14px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
}
.weak {
  color: var(--warn);
}
.empty {
  align-items: flex-start;
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
}
.note {
  color: var(--warn);
}
.kept,
.unused {
  list-style: none;
  margin: 0;
  padding: 0;
}
.kept li,
.unused li {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}
.kept li:last-child,
.unused li:last-child {
  border-bottom: 0;
}
</style>
