<script setup lang="ts">
/**
 * "Add pool" dialog shared by the setup wizard (Custom storage, Edit planned pool) and the
 * Storage page (Create pool). Step 1: tick drives and pick a layout, with a live estimate.
 * Step 2: name and review. It only emits the spec; the parent decides what saving means.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { ShieldAlert, ShieldCheck } from 'lucide-vue-next';
import type { Drive, LayoutEstimate, NewPoolSpec, PoolLayout } from '@apexos/api-types';
import Modal from '../Modal.vue';
import DriveRow from './DriveRow.vue';
import { ApiError, api } from '../../lib/api.ts';
import { formatBytes, toleranceText } from '../../lib/format.ts';
import {
  MAX_NEW_POOL_DRIVES,
  SIZE_TOLERANCE,
  defaultLayout,
  isWeakLayout,
  layoutDescription,
  layoutTitle,
  poolNameProblem,
  speedClass,
  speedClassLabel,
  suggestPoolName,
  validLayouts,
  type PickerDrive,
} from './drives.ts';

const props = withDefaults(
  defineProps<{
    drives: PickerDrive[];
    takenNames: string[];
    mode: 'plan' | 'create';
    title?: string;
    initial?: NewPoolSpec | null;
    saveLabel?: string;
    busy?: boolean;
    error?: string | null;
    fieldErrors?: Record<string, string>;
  }>(),
  { title: undefined, initial: null, saveLabel: undefined, busy: false, error: null, fieldErrors: () => ({}) },
);
const emit = defineEmits<{ save: [spec: NewPoolSpec, estimate: LayoutEstimate]; close: [] }>();

const page = ref<'pick' | 'review'>('pick');
const selected = ref<string[]>(props.initial ? [...props.initial.drives] : []);
const layout = ref<PoolLayout | null>(props.initial?.layout ?? null);
/** Once the user picks a layout we keep it while it stays valid; until then it follows the drive count. */
const layoutChosen = ref(Boolean(props.initial));
const name = ref(props.initial?.name ?? '');
const nameTouched = ref(Boolean(props.initial));
const consent = ref(false);

const byId = computed(() => new Map(props.drives.map((p) => [p.drive.identifier, p])));
const selectedDrives = computed(() => selected.value.map((id) => byId.value.get(id)?.drive).filter((d): d is Drive => Boolean(d)));
const count = computed(() => selectedDrives.value.length);
const layouts = computed(() => validLayouts(count.value));

// Keep the layout valid for the number of ticked drives.
watch(
  count,
  (n) => {
    if (n === 0) layout.value = null;
    else if (!layoutChosen.value || !layout.value || !layouts.value.includes(layout.value)) {
      const preferred = defaultLayout(n);
      layout.value = layouts.value.includes(preferred) ? preferred : (layouts.value[0] ?? null);
    }
  },
  { immediate: true },
);

const groups = computed(() => {
  const out: { key: 'hdd' | 'ssd'; label: string; items: PickerDrive[] }[] = [];
  for (const key of ['hdd', 'ssd'] as const) {
    const items = props.drives
      .filter((p) => speedClass(p.drive) === key)
      .sort((a, b) => Number(Boolean(a.disabledReason)) - Number(Boolean(b.disabledReason)) || b.drive.sizeBytes - a.drive.sizeBytes);
    if (items.length) out.push({ key, label: speedClassLabel(key), items });
  }
  return out;
});
const selectableCount = computed(() => props.drives.filter((p) => !p.disabledReason).length);

const selectedClasses = computed(() => new Set(selectedDrives.value.map(speedClass)));
const smallestSelected = computed(() => (count.value ? Math.min(...selectedDrives.value.map((d) => d.sizeBytes)) : 0));

/** Live hint for an unticked drive, based on what is already ticked. */
function hintFor(p: PickerDrive): string | null {
  if (!count.value || selected.value.includes(p.drive.identifier)) return null;
  const cls = speedClass(p.drive);
  if (!selectedClasses.value.has(cls)) return 'Mixing hard drives and SSDs slows the whole pool down to hard-drive speed.';
  if (layout.value !== 'STRIPE') {
    const s = smallestSelected.value;
    if (p.drive.sizeBytes > s * (1 + SIZE_TOLERANCE)) return `Bigger than the drives you ticked; only ${formatBytes(s)} of it would be used.`;
    if (p.drive.sizeBytes * (1 + SIZE_TOLERANCE) < s) return 'Smaller than the drives you ticked; every drive would only count as this size.';
  }
  return null;
}

function limitReached(p: PickerDrive): boolean {
  return count.value >= MAX_NEW_POOL_DRIVES && !selected.value.includes(p.drive.identifier);
}

function toggle(id: string, on: boolean) {
  selected.value = on ? [...selected.value, id] : selected.value.filter((x) => x !== id);
}

// Live estimate from the server (debounced; stale answers are dropped).
const estimate = ref<LayoutEstimate | null>(null);
const estimating = ref(false);
const estimateError = ref<string | null>(null);
let seq = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
watch(
  [selected, layout],
  () => {
    clearTimeout(timer);
    estimate.value = null;
    estimateError.value = null;
    if (!count.value || !layout.value) {
      estimating.value = false;
      return;
    }
    estimating.value = true;
    const mine = ++seq;
    const body = { layout: layout.value, drives: [...selected.value] };
    timer = setTimeout(async () => {
      try {
        const result = await api.post<LayoutEstimate>('/storage/estimate', body);
        if (mine === seq) estimate.value = result;
      } catch (e) {
        if (mine === seq) estimateError.value = e instanceof ApiError ? e.message : String(e);
      } finally {
        if (mine === seq) estimating.value = false;
      }
    }, 200);
  },
  { immediate: true, deep: true },
);
onBeforeUnmount(() => clearTimeout(timer));

const canContinue = computed(() => count.value > 0 && Boolean(layout.value) && Boolean(estimate.value?.valid) && !estimating.value);

function goReview() {
  if (!canContinue.value) return;
  if (!nameTouched.value) name.value = suggestPoolName(selectedDrives.value, props.takenNames);
  page.value = 'review';
}

const nameProblem = computed(() => poolNameProblem(name.value, props.takenNames));
const showNameProblem = ref(false);
/** A name error from the server stays until the user edits the name. */
const serverNameError = ref<string | null>(null);
watch(
  () => props.fieldErrors.name,
  (msg) => (serverNameError.value = msg ?? null),
  { immediate: true },
);
const nameError = computed(() => serverNameError.value ?? (showNameProblem.value ? nameProblem.value : null));

const drivesWithData = computed(() => selectedDrives.value.filter((d) => d.exportedPool || d.warnings.includes('EXISTING_DATA')));
const needsConsent = computed(() => props.mode === 'create');
const consentText = computed(() =>
  drivesWithData.value.length
    ? `I understand that everything on ${count.value === 1 ? 'this drive' : `these ${count.value} drives`} will be erased, including the existing data.`
    : `I understand that ${count.value === 1 ? 'this drive' : `these ${count.value} drives`} will be erased.`,
);

const canSave = computed(() => !nameProblem.value && Boolean(estimate.value?.valid) && (!needsConsent.value || consent.value) && !props.busy);

function save() {
  showNameProblem.value = true;
  if (!canSave.value || !layout.value || !estimate.value) return;
  emit('save', { name: name.value.trim(), layout: layout.value, drives: [...selected.value] }, estimate.value);
}

const heading = computed(() => props.title ?? (props.mode === 'create' ? 'Create a pool' : props.initial ? 'Edit pool' : 'Add a pool'));
const finalLabel = computed(() => props.saveLabel ?? (props.mode === 'create' ? 'Create pool' : props.initial ? 'Save changes' : 'Add to plan'));
</script>

<template>
  <Modal :title="heading" wide @close="emit('close')">
    <ol class="dialog-steps small" aria-label="Steps">
      <li :class="{ current: page === 'pick' }" :aria-current="page === 'pick' ? 'step' : undefined">1. Drives and layout</li>
      <li :class="{ current: page === 'review' }" :aria-current="page === 'review' ? 'step' : undefined">2. Name and review</li>
    </ol>

    <template v-if="page === 'pick'">
      <fieldset class="stack plain" style="--gap: 10px">
        <legend class="field-label">Which drives should be in this pool?</legend>
        <p v-if="!selectableCount" class="callout warn">There are no free drives right now. Connect a drive, or free one up first.</p>
        <div v-for="g in groups" :key="g.key" class="stack" style="--gap: 6px">
          <div class="group-label small muted">{{ g.label }}</div>
          <label
            v-for="p in g.items"
            :key="p.drive.identifier"
            class="pick"
            :class="{ on: selected.includes(p.drive.identifier), off: p.disabledReason || limitReached(p) }"
          >
            <DriveRow :drive="p.drive" :dim="Boolean(p.disabledReason)">
              <template #leading>
                <input
                  type="checkbox"
                  :checked="selected.includes(p.drive.identifier)"
                  :disabled="Boolean(p.disabledReason) || limitReached(p)"
                  :aria-label="`Use ${p.drive.model} (${p.drive.serial})`"
                  @change="toggle(p.drive.identifier, ($event.target as HTMLInputElement).checked)"
                />
              </template>
              <template #note>
                <span v-if="p.disabledReason" class="small muted">{{ p.disabledReason }}</span>
                <span v-else-if="limitReached(p)" class="small muted">A new pool can start with up to {{ MAX_NEW_POOL_DRIVES }} drives. You can add more later.</span>
                <template v-else>
                  <span v-if="p.note" class="small note">{{ p.note }}</span>
                  <span v-if="hintFor(p)" class="small hint-warn">{{ hintFor(p) }}</span>
                </template>
              </template>
            </DriveRow>
          </label>
        </div>
      </fieldset>

      <fieldset class="stack plain" style="--gap: 8px">
        <legend class="field-label">Layout</legend>
        <p v-if="!count" class="small muted">Tick at least one drive to see the layouts you can use.</p>
        <label v-for="l in layouts" :key="l" class="layout-option" :class="{ on: layout === l }">
          <input v-model="layout" type="radio" name="pool-layout" :value="l" @change="layoutChosen = true" />
          <div class="stack" style="--gap: 2px">
            <div class="row" style="--gap: 8px">
              <strong>{{ layoutTitle(l, count) }}</strong>
              <span v-if="isWeakLayout(l)" class="badge warn">No protection</span>
            </div>
            <span class="small muted">{{ layoutDescription(l, count) }}</span>
          </div>
        </label>
      </fieldset>

      <div v-if="count" class="estimate" aria-live="polite">
        <div class="row wrap" style="--gap: 24px">
          <div>
            <div class="small muted">Usable space</div>
            <div class="big">
              <span v-if="estimating" class="spin" aria-label="Calculating" />
              <template v-else-if="estimate">about {{ formatBytes(estimate.usableBytes) }}</template>
              <template v-else>—</template>
            </div>
          </div>
          <div>
            <div class="small muted">Protection</div>
            <div class="big row" style="--gap: 6px">
              <template v-if="estimate && !estimating">
                <ShieldCheck v-if="estimate.faultTolerance > 0" :size="18" style="color: var(--ok)" aria-hidden="true" />
                <ShieldAlert v-else :size="18" style="color: var(--warn)" aria-hidden="true" />
                {{ toleranceText(estimate.faultTolerance) }}
              </template>
              <template v-else>—</template>
            </div>
          </div>
        </div>
        <template v-if="estimate && !estimating">
          <p v-for="p in estimate.problems" :key="p" class="callout err">{{ p }}</p>
          <p v-for="w in estimate.warnings" :key="w" class="callout warn">{{ w }}</p>
        </template>
        <p v-if="estimateError" class="callout err">{{ estimateError }}</p>
      </div>
    </template>

    <template v-else>
      <div class="field">
        <label for="pool-name">Pool name</label>
        <input
          id="pool-name"
          v-model="name"
          type="text"
          autocomplete="off"
          :aria-invalid="Boolean(nameError)"
          aria-describedby="pool-name-hint"
          @input="
            nameTouched = true;
            serverNameError = null;
          "
          @blur="showNameProblem = true"
        />
        <span v-if="nameError" class="error-text">{{ nameError }}</span>
        <span id="pool-name-hint" class="hint">Used for the pool's folder on the server. You can give it a friendlier display name later.</span>
      </div>

      <div class="summary">
        <div>
          <div class="small muted">Layout</div>
          <strong>{{ layout ? layoutTitle(layout, count) : '—' }}</strong>
        </div>
        <div>
          <div class="small muted">Drives</div>
          <strong>{{ count }}</strong>
        </div>
        <div>
          <div class="small muted">Usable space</div>
          <strong>about {{ formatBytes(estimate?.usableBytes) }}</strong>
        </div>
        <div>
          <div class="small muted">Protection</div>
          <strong>{{ toleranceText(estimate?.faultTolerance ?? null) }}</strong>
        </div>
      </div>

      <ul class="drive-list">
        <li v-for="d in selectedDrives" :key="d.identifier"><DriveRow :drive="d" /></li>
      </ul>

      <p v-for="w in estimate?.warnings ?? []" :key="w" class="callout warn">{{ w }}</p>
      <p v-if="mode === 'plan'" class="callout">This only adds the pool to your plan. Nothing is written to the drives until you finish setup.</p>
      <p v-else-if="drivesWithData.length" class="callout warn">
        {{ drivesWithData.length === 1 ? 'One of these drives has' : `${drivesWithData.length} of these drives have` }} existing data on
        {{ drivesWithData.length === 1 ? 'it' : 'them' }}. Creating the pool erases it for good.
      </p>
      <label v-if="needsConsent" class="row consent" style="--gap: 10px">
        <input v-model="consent" type="checkbox" />
        <span>{{ consentText }}</span>
      </label>
    </template>

    <p v-if="error" class="callout err">{{ error }}</p>

    <template #footer>
      <template v-if="page === 'pick'">
        <button class="btn" @click="emit('close')">Cancel</button>
        <button class="btn primary" :disabled="!canContinue" @click="goReview">Continue</button>
      </template>
      <template v-else>
        <button class="btn" :disabled="busy" @click="page = 'pick'">Back</button>
        <button class="btn primary" :disabled="!canSave" @click="save"><span v-if="busy" class="spin" />{{ finalLabel }}</button>
      </template>
    </template>
  </Modal>
</template>

<style scoped>
fieldset.plain {
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
}
fieldset.plain legend {
  padding: 0;
  margin-bottom: 8px;
}
.dialog-steps {
  list-style: none;
  margin: -6px 0 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  color: var(--text-muted);
}
.dialog-steps .current {
  color: var(--accent-strong);
  font-weight: 600;
}
.group-label {
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-size: 0.75rem;
}
.pick,
.layout-option {
  display: block;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  cursor: pointer;
  background: var(--surface);
}
.pick:hover:not(.off),
.layout-option:hover {
  border-color: var(--accent);
}
.pick.on,
.layout-option.on {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.pick.off {
  cursor: default;
  background: var(--surface-2);
}
.layout-option {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.layout-option input {
  margin-top: 4px;
  flex: none;
}
.note {
  color: var(--info);
}
.hint-warn {
  color: var(--warn);
}
.estimate {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
}
.big {
  font-size: 1.15rem;
  font-weight: 650;
  min-height: 1.6em;
  display: flex;
  align-items: center;
}
.summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 12px;
  padding: 14px 16px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
}
.drive-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.drive-list li {
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.consent {
  align-items: flex-start;
  font-weight: 550;
}
.consent input {
  margin-top: 3px;
  flex: none;
}
</style>
