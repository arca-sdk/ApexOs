<script setup lang="ts">
/**
 * First-run setup wizard: basics → health → existing pools → new storage → review → finish.
 * One decision per screen; nothing is written to the server until "Finish setup".
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ArrowLeft, Check, Flame } from 'lucide-vue-next';
import type { SetupInfo, Task, TaskStarted } from '@hearth/api-types';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import PageState from '../components/PageState.vue';
import SetupProgress from '../components/setup/SetupProgress.vue';
import StepBasics from '../components/setup/StepBasics.vue';
import StepExistingPools from '../components/setup/StepExistingPools.vue';
import StepHealth from '../components/setup/StepHealth.vue';
import StepPriority from '../components/setup/StepPriority.vue';
import StepReview from '../components/setup/StepReview.vue';
import StepStorageMode from '../components/setup/StepStorageMode.vue';
import StepStoragePlan from '../components/setup/StepStoragePlan.vue';
import { createWizard, provideWizard, serverNameProblem, type ScreenId } from '../components/setup/wizard.ts';
import { pollRunningTask } from '../components/storage/taskPoll.ts';
import { ApiError, api, refreshStatus } from '../lib/api.ts';
import { live } from '../lib/events.ts';

const router = useRouter();
const wizard = createWizard();
provideWizard(wizard);
const { state } = wizard;

const loading = ref(true);
const loadError = ref<string | null>(null);
const screen = ref<ScreenId>('basics');
const phase = ref<'wizard' | 'working'>('wizard');
const advancing = ref(false);
const finishing = ref(false);
const finishError = ref<string | null>(null);
const startFreshOpen = ref(false);
const leaving = ref(false);
const heading = ref<HTMLElement | null>(null);

const taskId = ref<string | null>(null);
const startedTask = ref<Task | null>(null);
const task = computed<Task | null>(() => (taskId.value ? (live.tasks[taskId.value] ?? startedTask.value) : null));
// Keep the checklist current even if the live event stream silently drops (e.g. the server restarts).
pollRunningTask(() => (phase.value === 'working' ? taskId.value : null));

async function load() {
  loading.value = true;
  loadError.value = null;
  try {
    wizard.init(await api.get<SetupInfo>('/setup'));
    if (state.importable.status === 'idle' || state.importable.status === 'error') void wizard.loadImportable();
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

/** Re-reads drives and pools without leaving the current screen. */
async function refreshInfo() {
  try {
    wizard.init(await api.get<SetupInfo>('/setup'));
  } catch {
    // Keep what we have; the review shows the server's verdict.
  }
}

// After a page reload during setup, pick up the running setup task instead of starting over.
watch(
  () => Object.values(live.tasks).find((t) => t.type === 'setup' && t.status === 'running')?.id,
  (id) => {
    if (id && phase.value === 'wizard' && !finishing.value) {
      taskId.value = id;
      startedTask.value = live.tasks[id] ?? null;
      phase.value = 'working';
    }
  },
  { immediate: true },
);

// ---------------------------------------------------------------------------------------------
// Steps and navigation
// ---------------------------------------------------------------------------------------------

const ORDER: ScreenId[] = ['basics', 'health', 'existing', 'storage-mode', 'storage-priority', 'storage-plan', 'review'];
const GROUP: Record<ScreenId, string> = {
  basics: 'Basics',
  health: 'Health check',
  existing: 'Existing pools',
  'storage-mode': 'Storage',
  'storage-priority': 'Storage',
  'storage-plan': 'Storage',
  review: 'Review',
};
const steps = computed(() => [...new Set(wizard.screens.value.map((s) => GROUP[s]))]);
const stepIndex = computed(() => steps.value.indexOf(GROUP[screen.value]));
const progress = computed(() => {
  if (phase.value === 'working') return task.value?.status === 'success' ? 100 : 96;
  const list = wizard.screens.value;
  const i = Math.max(0, list.indexOf(screen.value));
  return Math.round(((i + 1) / (list.length + 1)) * 100);
});

function neighbour(direction: 1 | -1): ScreenId | null {
  const list = wizard.screens.value;
  const pos = ORDER.indexOf(screen.value);
  const candidates = direction === 1 ? ORDER.slice(pos + 1) : ORDER.slice(0, pos).reverse();
  return candidates.find((s) => list.includes(s)) ?? null;
}

async function go(s: ScreenId) {
  screen.value = s;
  finishError.value = null;
  if (s === 'review') state.returnToReview = false;
  window.scrollTo({ top: 0 });
  await nextTick();
  heading.value?.focus();
}

watch(screen, (s) => {
  if (s === 'existing') {
    state.visitedExisting = true;
    if (state.importable.status === 'error' || state.importable.status === 'idle') void wizard.loadImportable();
  }
  if (s === 'storage-plan') {
    if (state.mode === 'recommended') void wizard.ensurePlan();
    else wizard.pruneCustom();
  }
  if (s === 'review') void wizard.loadReview();
});

const modeValid = computed(() => {
  if (!state.mode) return false;
  if (state.mode === 'none') return wizard.somethingKept.value;
  return wizard.candidates.value.length > 0;
});

const reviewReady = computed(() => {
  const r = state.review;
  if (!r || state.reviewLoading || !r.ok || wizard.nameClashes.value.length) return false;
  return (!r.needsEraseConsent || state.consentErase) && (!r.needsKeepConsent || state.consentKeep);
});

const canContinue = computed(() => {
  switch (screen.value) {
    case 'basics':
      return !serverNameProblem(state.serverName) && Boolean(state.info?.timezones.includes(state.timezone));
    case 'health':
      return true;
    case 'existing':
      return state.importable.status === 'loaded';
    case 'storage-mode':
      return modeValid.value;
    case 'storage-priority':
      return Boolean(state.priority);
    case 'storage-plan':
      return wizard.storageValid.value;
    case 'review':
      return reviewReady.value && !finishing.value;
  }
  return false;
});

/** Screens before the storage plan can jump straight back to the review when opened from an Edit link. */
const backToReview = computed(
  () => state.returnToReview && ['basics', 'health', 'existing'].includes(screen.value) && wizard.storageValid.value,
);

const continueLabel = computed(() => {
  if (screen.value === 'review') return 'Finish setup';
  if (backToReview.value) return 'Back to review';
  if (screen.value === 'storage-priority') return 'Show my plan';
  return 'Continue';
});

async function next() {
  if (!canContinue.value || advancing.value) return;
  const s = screen.value;
  if (s === 'review') return finish();
  if (backToReview.value) return go('review');
  advancing.value = true;
  try {
    if (s === 'storage-mode' && state.mode === 'recommended' && wizard.candidates.value.length < 2) await wizard.ensurePlan();
    if (s === 'storage-priority') await wizard.ensurePlan();
  } finally {
    advancing.value = false;
  }
  const to = neighbour(1);
  if (to) await go(to);
}

function back() {
  const to = neighbour(-1);
  if (to) void go(to);
}

function editFromReview(s: ScreenId) {
  state.returnToReview = true;
  void go(s);
}

// "Skip — start fresh": keep and import nothing.
const hasPoolsToSkip = computed(() => wizard.existingPools.value.length > 0 || state.importable.pools.length > 0);
function startFresh() {
  for (const name of Object.keys(state.keep)) state.keep[name] = false;
  for (const guid of Object.keys(state.importSel)) state.importSel[guid] = false;
  startFreshOpen.value = false;
  if (state.mode === 'none') wizard.setMode('recommended');
  state.returnToReview = false;
  const to = neighbour(1);
  if (to) void go(to);
}
const startFreshNames = computed(() => [...wizard.existingPools.value.map((p) => p.displayName), ...state.importable.pools.map((p) => p.name)]);

// ---------------------------------------------------------------------------------------------
// Finish
// ---------------------------------------------------------------------------------------------

async function finish() {
  finishing.value = true;
  finishError.value = null;
  try {
    const { task: t } = await api.post<TaskStarted>('/setup/finish', wizard.request(true));
    startedTask.value = t;
    taskId.value = t.id;
    phase.value = 'working';
    window.scrollTo({ top: 0 });
  } catch (e) {
    finishError.value = e instanceof Error ? e.message : String(e);
    if (e instanceof ApiError && ['SETUP_INVALID', 'PLAN_STALE', 'DRIVE_GONE'].includes(e.code)) {
      // Something changed on the server: look at the drives again (keeping the user's choices) and re-check.
      finishError.value = `${e.message} Hearth has looked at your drives again; use Edit to adjust the plan.`;
      await refreshInfo();
      await wizard.loadReview();
    }
  } finally {
    finishing.value = false;
  }
}

async function toDashboard() {
  leaving.value = true;
  try {
    await refreshStatus();
    await router.replace('/');
  } finally {
    leaving.value = false;
  }
}

/** After a failed finish: re-read drives and pools, keep basics, and plan storage again. */
async function replan() {
  phase.value = 'wizard';
  taskId.value = null;
  startedTask.value = null;
  wizard.resetStorage();
  state.importable.status = 'idle';
  await load();
  void go(wizard.screens.value.includes('existing') ? 'existing' : 'storage-mode');
}

// ---------------------------------------------------------------------------------------------
// Copy for the left-hand column
// ---------------------------------------------------------------------------------------------

const intro = computed<{ title: string; text: string[] }>(() => {
  const free = wizard.candidates.value.length;
  switch (screen.value) {
    case 'basics':
      return {
        title: 'Server basics',
        text: ['Give your server a name and tell it where in the world it is.', 'You can change both later in Settings.'],
      };
    case 'health':
      return {
        title: 'Health & capabilities',
        text: [
          'Hearth looked over your hardware. Open a card to see what it checked and what it found.',
          'Anything marked red deserves a fix before you trust this server with your files, but it won’t stop you from continuing.',
        ],
      };
    case 'existing':
      return {
        title: 'Existing pools',
        text: [
          'Some of your drives already hold storage pools. Choose which ones to keep. Kept pools stay exactly as they are, with their folders, files and apps.',
          'Nothing is erased on this screen. A pool you let go is only erased if you reuse its drives for a new pool, and you’ll confirm that at the end.',
        ],
      };
    case 'storage-mode':
      return {
        title: 'New storage',
        text: [
          free
            ? `You have ${free} ${free === 1 ? 'drive' : 'drives'} to build new pools from. Let Hearth suggest a layout, or build the pools yourself.`
            : 'There are no free drives to build new pools from.',
          'A pool combines drives into one place for your files. With protection, it keeps working when a drive fails.',
        ],
      };
    case 'storage-priority':
      return {
        title: 'What matters most?',
        text: [
          `With ${free} drives you can trade space for protection. More protection means more drives can fail without losing anything, but you get less space.`,
          'You can fine-tune the result on the next screen.',
        ],
      };
    case 'storage-plan':
      return state.mode === 'custom'
        ? {
            title: 'Build your storage',
            text: [
              'Add pools one at a time: tick the drives, then choose a layout. Hearth shows the usable space and protection as you go.',
              'Nothing is created until you finish setup.',
            ],
          }
        : {
            title: 'Your storage plan',
            text: [
              'Here’s what Hearth suggests. Drives of different kinds stay in separate pools, and similar sizes are grouped so no space is wasted.',
              'Rename, edit or remove pools as you like. Nothing is created until you finish setup.',
            ],
          };
    case 'review':
      return {
        title: 'Almost done!',
        text: ['Check that everything looks right. Use Edit to change something.', 'Nothing has been written to your drives yet. That happens when you press Finish setup.'],
      };
  }
  return { title: '', text: [] };
});

const eraseConsentText = computed(() => {
  const r = state.review;
  if (!r) return '';
  const drives = r.newPools.reduce((s, p) => s + p.drives.length, 0);
  const parts = [`I understand that the ${drives === 1 ? 'drive' : `${drives} drives`} used for new pools will be erased`];
  if (r.erasePools.length) parts.push(`, which deletes ${r.erasePools.length === 1 ? 'the pool' : 'the pools'} ${r.erasePools.join(', ')} completely`);
  return `${parts.join('')}. This can’t be undone.`;
});
const keepConsentText = computed(() => {
  const names = [...wizard.keptPools.value.map((p) => p.displayName), ...wizard.importNames.value];
  return `I understand what I’m keeping: ${names.join(', ')} ${names.length === 1 ? 'stays' : 'stay'} as ${names.length === 1 ? 'it is' : 'they are'}, with everything on ${names.length === 1 ? 'it' : 'them'}.`;
});
</script>

<template>
  <div class="setup">
    <header class="setup-header">
      <div class="header-inner">
        <div class="row brand" style="--gap: 8px">
          <Flame :size="22" aria-hidden="true" class="flame" />
          <strong>Server setup</strong>
        </div>
        <ol v-if="phase === 'wizard'" class="step-names" aria-label="Setup steps">
          <li
            v-for="(name, i) in steps"
            :key="name"
            :class="{ done: i < stepIndex, current: i === stepIndex }"
            :aria-current="i === stepIndex ? 'step' : undefined"
          >
            <span class="dot" aria-hidden="true"><Check v-if="i < stepIndex" :size="12" /><template v-else>{{ i + 1 }}</template></span>
            <span class="label">{{ name }}</span>
          </li>
        </ol>
        <span v-if="phase === 'wizard'" class="step-compact small muted">Step {{ stepIndex + 1 }} of {{ steps.length }} · {{ steps[stepIndex] }}</span>
      </div>
      <div class="progress" role="progressbar" :aria-valuenow="progress" aria-valuemin="0" aria-valuemax="100" aria-label="Setup progress">
        <span :style="{ width: `${progress}%` }" />
      </div>
    </header>

    <div v-if="loading || loadError" class="state-wrap">
      <PageState :loading="loading" :error="loadError" @retry="load" />
    </div>

    <SetupProgress v-else-if="phase === 'working' && task" :task="task" :leaving="leaving" @dashboard="toDashboard" @replan="replan" />

    <main v-else-if="state.info" class="body">
      <div class="left">
        <div class="intro stack" style="--gap: 10px">
          <h1 ref="heading" tabindex="-1">{{ intro.title }}</h1>
          <p v-for="t in intro.text" :key="t" class="muted">{{ t }}</p>
        </div>

        <div
          v-if="screen === 'review' && state.review && (state.review.needsEraseConsent || state.review.needsKeepConsent || finishError)"
          class="consents stack"
          style="--gap: 10px"
        >
          <label v-if="state.review.needsEraseConsent" class="consent erase">
            <input v-model="state.consentErase" type="checkbox" />
            <span>{{ eraseConsentText }}</span>
          </label>
          <label v-if="state.review.needsKeepConsent" class="consent">
            <input v-model="state.consentKeep" type="checkbox" />
            <span>{{ keepConsentText }}</span>
          </label>
          <p v-if="finishError" class="callout err small" role="alert">{{ finishError }}</p>
        </div>

        <div class="actions-area">
          <div class="actions">
            <button v-if="neighbour(-1)" class="btn" :disabled="advancing || finishing" @click="back"><ArrowLeft :size="16" aria-hidden="true" /> Back</button>
            <span class="spacer" />
            <button class="btn primary" :disabled="!canContinue || advancing" @click="next">
              <span v-if="advancing || finishing" class="spin" />{{ continueLabel }}
            </button>
          </div>
          <div v-if="screen === 'existing' && hasPoolsToSkip && state.importable.status === 'loaded'" class="secondary-action">
            <button class="btn ghost small" @click="startFreshOpen = true">Skip — start fresh</button>
            <span class="small muted">Keep and import nothing.</span>
          </div>
        </div>
      </div>

      <section class="right" :aria-label="intro.title">
        <StepBasics v-if="screen === 'basics'" />
        <StepHealth v-else-if="screen === 'health'" />
        <StepExistingPools v-else-if="screen === 'existing'" />
        <StepStorageMode v-else-if="screen === 'storage-mode'" />
        <StepPriority v-else-if="screen === 'storage-priority'" />
        <StepStoragePlan v-else-if="screen === 'storage-plan'" />
        <StepReview v-else-if="screen === 'review'" @edit="editFromReview" />
      </section>
    </main>

    <ConfirmDialog
      v-if="startFreshOpen"
      title="Start fresh?"
      :message="`None of your existing pools will be kept or imported (${startFreshNames.join(', ')}). Their drives become free for new pools, and any pool whose drives you reuse is erased completely when you finish setup. Nothing is erased yet.`"
      checkbox="I understand that my existing pools can be erased."
      action-label="Start fresh"
      danger
      @confirm="startFresh"
      @close="startFreshOpen = false"
    />
  </div>
</template>

<style scoped>
.setup {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}
.setup-header {
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  z-index: 10;
}
.header-inner {
  max-width: 1160px;
  margin: 0 auto;
  padding: 14px 24px;
  display: flex;
  align-items: center;
  gap: 24px;
  flex-wrap: wrap;
}
.brand {
  font-size: 1.05rem;
}
.flame {
  color: var(--accent);
}
.step-names {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  gap: 18px;
  flex-wrap: wrap;
  margin-left: auto;
}
.step-names li {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-muted);
  font-size: 0.9rem;
}
.step-names .dot {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-size: 0.75rem;
  font-weight: 650;
  background: var(--surface-2);
  border: 1px solid var(--border);
}
.step-names li.current {
  color: var(--text);
  font-weight: 600;
}
.step-names li.current .dot {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
}
.step-names li.done .dot {
  background: var(--accent-soft);
  border-color: var(--accent-soft);
  color: var(--accent-strong);
}
.step-compact {
  display: none;
  margin-left: auto;
}
.progress {
  height: 4px;
  background: var(--surface-2);
}
.progress > span {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width 0.3s;
}
.state-wrap {
  max-width: 1160px;
  margin: 0 auto;
  padding: 32px 24px;
  width: 100%;
}
.body {
  width: 100%;
  max-width: 1160px;
  margin: 0 auto;
  padding: 36px 24px 64px;
  display: grid;
  grid-template-columns: minmax(260px, 360px) minmax(0, 1fr);
  gap: 48px;
  align-items: start;
}
.left {
  position: sticky;
  top: 96px;
  display: flex;
  flex-direction: column;
  gap: 28px;
}
.intro h1 {
  outline: none;
}
.actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.secondary-action {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 8px;
  margin-top: 10px;
}
.secondary-action .btn {
  padding-left: 0;
  padding-right: 4px;
  text-decoration: underline;
}
.consent {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  font-size: 0.92rem;
  font-weight: 550;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  border: 1px solid var(--border);
  cursor: pointer;
}
.consent.erase {
  background: var(--err-soft);
  border-color: var(--err);
}
.consent input {
  margin-top: 3px;
  flex: none;
}
.right {
  min-width: 0;
}

@media (max-width: 900px) {
  .step-names {
    display: none;
  }
  .step-compact {
    display: inline;
  }
  .header-inner {
    padding: 12px 16px;
  }
  .body {
    grid-template-columns: minmax(0, 1fr);
    gap: 20px;
    padding: 20px 16px 0;
  }
  .left {
    display: contents;
  }
  .intro {
    order: 0;
  }
  .right {
    order: 1;
  }
  .consents {
    order: 2;
  }
  .actions-area {
    order: 3;
    position: sticky;
    bottom: 0;
    margin: 0 -16px;
    padding: 12px 16px 16px;
    background: var(--surface);
    border-top: 1px solid var(--border);
    z-index: 5;
  }
}
</style>
