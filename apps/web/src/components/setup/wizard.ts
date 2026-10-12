/**
 * State of the first-run setup wizard. Lives only in memory (nothing persists across a reload),
 * is created by SetupView and shared with the step components through provide/inject.
 */
import { computed, inject, provide, reactive, type InjectionKey } from 'vue';
import type {
  Drive,
  ExistingPoolSummary,
  ImportablePool,
  NewPoolSpec,
  PlanPriority,
  PoolPlan,
  SetupInfo,
  SetupRequest,
  SetupReview,
} from '@hearth/api-types';
import { ApiError, api } from '../../lib/api.ts';
import type { PickerDrive } from '../storage/drives.ts';

export type ScreenId = 'basics' | 'health' | 'existing' | 'storage-mode' | 'storage-priority' | 'storage-plan' | 'review';
export type StorageMode = 'recommended' | 'custom' | 'none';

/** A pool in the plan (recommended or custom), with what the user needs to judge it. */
export interface PlannedNewPool extends NewPoolSpec {
  usableBytes: number;
  faultTolerance: number;
  reason: string | null;
  warnings: string[];
}

/** Same rule as the server: 2–15 letters, digits or dashes, starting with a letter, not ending with a dash. */
export const SERVER_NAME_RE = /^[a-zA-Z][a-zA-Z0-9-]{0,13}[a-zA-Z0-9]$/;

export function serverNameProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return 'Give your server a name.';
  if (n.length < 2 || n.length > 15) return 'Use 2 to 15 characters.';
  if (!/^[a-zA-Z]/.test(n)) return 'Start with a letter.';
  if (!/^[a-zA-Z0-9-]+$/.test(n)) return 'Use only letters, numbers and dashes.';
  if (n.endsWith('-')) return 'Don’t end with a dash.';
  return SERVER_NAME_RE.test(n) ? null : 'Use 2–15 letters, numbers or dashes, starting with a letter.';
}

function message(e: unknown): string {
  return e instanceof ApiError || e instanceof Error ? e.message : String(e);
}

export function createWizard() {
  const state = reactive({
    info: null as SetupInfo | null,
    serverName: '',
    timezone: '',
    importable: { status: 'idle' as 'idle' | 'loading' | 'loaded' | 'error', pools: [] as ImportablePool[], error: null as string | null },
    /** Local pool name → keep it. */
    keep: {} as Record<string, boolean>,
    /** Foreign pool GUID → import it. */
    importSel: {} as Record<string, boolean>,
    visitedExisting: false,
    mode: null as StorageMode | null,
    priority: null as PlanPriority | null,
    /** What the current recommended plan was computed for; a mismatch means "plan again". */
    planSignature: null as string | null,
    planUnassigned: {} as Record<string, string>,
    planLoading: false,
    planError: null as string | null,
    newPools: [] as PlannedNewPool[],
    review: null as SetupReview | null,
    reviewSignature: null as string | null,
    reviewLoading: false,
    reviewError: null as string | null,
    consentErase: false,
    consentKeep: false,
    /** Set by the review's Edit links so earlier steps offer "Back to review". */
    returnToReview: false,
  });

  /** (Re)loads facts from the server, keeping the user's choices where they still apply. */
  function init(info: SetupInfo) {
    state.info = info;
    if (!state.serverName) state.serverName = info.suggestedName;
    if (!state.timezone || !info.timezones.includes(state.timezone)) state.timezone = info.timezone;
    const keep: Record<string, boolean> = {};
    for (const p of info.existingPools) keep[p.name] = state.keep[p.name] ?? true;
    state.keep = keep;
  }

  async function loadImportable(fresh = false) {
    state.importable.status = 'loading';
    state.importable.error = null;
    try {
      const pools = await api.get<ImportablePool[]>(`/storage/importable${fresh ? '?fresh=1' : ''}`);
      const sel: Record<string, boolean> = {};
      for (const p of pools) sel[p.guid] = state.importSel[p.guid] ?? true;
      state.importSel = sel;
      state.importable.pools = pools;
      state.importable.status = 'loaded';
    } catch (e) {
      state.importable.error = message(e);
      state.importable.status = 'error';
    }
  }

  const existingPools = computed<ExistingPoolSummary[]>(() => state.info?.existingPools ?? []);
  const drives = computed<Drive[]>(() => state.info?.drives ?? []);
  const keptPools = computed(() => existingPools.value.filter((p) => state.keep[p.name]));
  const keptNames = computed(() => keptPools.value.map((p) => p.name));
  const letGoNames = computed(() => existingPools.value.filter((p) => !state.keep[p.name]).map((p) => p.name));
  const importing = computed(() => state.importable.pools.filter((p) => state.importSel[p.guid]));
  const importNames = computed(() => importing.value.map((p) => p.name));
  /** Names new pools may not use. */
  const takenNames = computed(() => [...keptNames.value, ...importNames.value]);
  const somethingKept = computed(() => keptNames.value.length + importNames.value.length > 0);

  /** Drives new pools may use: free drives plus drives of pools the user let go (never imported pools' drives). */
  const candidates = computed<Drive[]>(() => {
    const letGo = new Set(letGoNames.value);
    const imported = new Set(importNames.value);
    return drives.value.filter((d) => {
      if (d.missing) return false;
      if (d.pool) return letGo.has(d.pool);
      return d.available && !(d.exportedPool && imported.has(d.exportedPool));
    });
  });
  const candidateIds = computed(() => new Set(candidates.value.map((d) => d.identifier)));
  const candidateSignature = computed(() => JSON.stringify([[...candidateIds.value].sort(), [...takenNames.value].sort()]));

  function driveNote(d: Drive): string | null {
    if (d.pool) return `From the pool ${d.pool}, which you’re not keeping. Using it erases that whole pool.`;
    if (d.exportedPool) return `Holds the pool “${d.exportedPool}” from another system. Using it erases that pool.`;
    if (d.warnings.includes('EXISTING_DATA')) return 'Has existing data, which will be erased.';
    return null;
  }

  /** Every drive with a reason when it can't be picked for a new pool. */
  function pickerDrives(exceptPool?: string): PickerDrive[] {
    const usedBy = new Map<string, string>();
    for (const p of state.newPools) if (p.name !== exceptPool) for (const id of p.drives) usedBy.set(id, p.name);
    const imported = new Set(importNames.value);
    return drives.value
      .filter((d) => !d.missing)
      .map((d) => {
        let disabledReason: string | null = null;
        if (usedBy.has(d.identifier)) disabledReason = `Already in the planned pool ${usedBy.get(d.identifier)}.`;
        else if (!candidateIds.value.has(d.identifier)) {
          if (d.pool) disabledReason = `Part of ${d.pool}, which you’re keeping.`;
          else if (d.exportedPool && imported.has(d.exportedPool)) disabledReason = `Part of ${d.exportedPool}, which you’re importing.`;
          else disabledReason = d.unavailableReason ?? 'Can’t be used for a pool.';
        }
        return { drive: d, disabledReason, note: disabledReason ? null : driveNote(d) };
      });
  }

  const assignedIds = computed(() => new Set(state.newPools.flatMap((p) => p.drives)));
  const unassignedCandidates = computed(() => candidates.value.filter((d) => !assignedIds.value.has(d.identifier)));

  const showExisting = computed(
    () =>
      existingPools.value.length > 0 ||
      state.importable.status !== 'loaded' ||
      state.importable.pools.length > 0 ||
      state.visitedExisting,
  );

  const screens = computed<ScreenId[]>(() => {
    const s: ScreenId[] = ['basics', 'health'];
    if (showExisting.value) s.push('existing');
    s.push('storage-mode');
    if (state.mode === 'recommended' && candidates.value.length >= 2) s.push('storage-priority');
    if (state.mode === 'recommended' || state.mode === 'custom') s.push('storage-plan');
    s.push('review');
    return s;
  });

  function setMode(mode: StorageMode) {
    if (mode === state.mode) return;
    state.mode = mode;
    state.newPools = [];
    state.planSignature = null;
    state.planUnassigned = {};
    state.planError = null;
  }

  function priorityChoices(): PlanPriority[] {
    const n = candidates.value.length;
    if (n <= 1) return [];
    return n === 2 ? ['space', 'protection'] : ['space', 'balanced', 'protection'];
  }

  function effectivePriority(): PlanPriority {
    const choices = priorityChoices();
    if (state.priority && choices.includes(state.priority)) return state.priority;
    return choices.includes('balanced') ? 'balanced' : 'protection';
  }

  /** Asks the server for a recommended plan, unless the current one (with the user's edits) still applies. */
  async function ensurePlan(): Promise<boolean> {
    const priority = effectivePriority();
    const signature = JSON.stringify([priority, candidateSignature.value]);
    if (state.planSignature === signature && !state.planError) return true;
    if (!candidates.value.length) {
      state.newPools = [];
      state.planUnassigned = {};
      state.planSignature = signature;
      return true;
    }
    state.planLoading = true;
    state.planError = null;
    try {
      const plan = await api.post<PoolPlan>('/storage/plan', {
        priority,
        drives: candidates.value.map((d) => d.identifier),
        takenNames: takenNames.value,
      });
      state.newPools = plan.pools.map((p) => ({
        name: p.name,
        layout: p.layout,
        drives: p.drives,
        usableBytes: p.usableBytes,
        faultTolerance: p.faultTolerance,
        reason: p.reason,
        warnings: p.warnings,
      }));
      state.planUnassigned = Object.fromEntries(plan.unassigned.map((u) => [u.identifier, u.reason]));
      state.planSignature = signature;
      return true;
    } catch (e) {
      state.planError = message(e);
      return false;
    } finally {
      state.planLoading = false;
    }
  }

  /** Drops planned pools that use drives which are no longer free (e.g. after keeping a pool again). */
  function pruneCustom() {
    state.newPools = state.newPools.filter((p) => p.drives.every((id) => candidateIds.value.has(id)));
  }

  /** The storage part of the plan is consistent with the current keep/import choices. */
  const storageValid = computed(() => {
    if (!state.mode) return false;
    if (state.mode === 'none') return somethingKept.value;
    if (state.planLoading || state.planError) return false;
    const ok = state.newPools.every((p) => p.drives.every((id) => candidateIds.value.has(id)));
    return ok && state.newPools.length + keptNames.value.length + importNames.value.length > 0;
  });

  function request(withConsent: boolean): SetupRequest {
    return {
      serverName: state.serverName.trim(),
      timezone: state.timezone,
      keepPools: keptNames.value,
      importPools: importing.value.map((p) => p.guid),
      newPools: state.newPools.map(({ name, layout, drives: d }) => ({ name, layout, drives: [...d] })),
      consentErase: withConsent && state.consentErase,
      consentKeep: withConsent && state.consentKeep,
    };
  }

  async function loadReview() {
    const req = request(false);
    const signature = JSON.stringify([req.keepPools, req.importPools, req.newPools]);
    // Consents only count for the exact storage plan (kept, imported and new pools) they were given for.
    if (signature !== state.reviewSignature) {
      state.consentErase = false;
      state.consentKeep = false;
    }
    state.reviewLoading = true;
    state.reviewError = null;
    try {
      state.review = await api.post<SetupReview>('/setup/review', req);
      state.reviewSignature = signature;
    } catch (e) {
      state.review = null;
      state.reviewError = message(e);
    } finally {
      state.reviewLoading = false;
    }
  }

  /**
   * New pools named like an existing pool that stays on its drives (let go but not erased) would
   * fail when created, so the review blocks them. (The server's review doesn't catch this yet.)
   */
  const nameClashes = computed(() => {
    const r = state.review;
    if (!r) return [];
    const staying = [...r.untouchedPools, ...keptNames.value, ...importNames.value].map((n) => n.toLowerCase());
    return r.newPools.filter((p) => staying.includes(p.name.toLowerCase())).map((p) => p.name);
  });

  /** After a failed or stale finish: forget the storage plan and look at the drives again. */
  function resetStorage() {
    state.mode = null;
    state.priority = null;
    state.newPools = [];
    state.planSignature = null;
    state.planUnassigned = {};
    state.review = null;
    state.reviewSignature = null;
    state.consentErase = false;
    state.consentKeep = false;
    state.returnToReview = false;
  }

  return {
    state,
    init,
    loadImportable,
    existingPools,
    drives,
    keptPools,
    keptNames,
    letGoNames,
    importing,
    importNames,
    takenNames,
    somethingKept,
    candidates,
    candidateIds,
    pickerDrives,
    driveNote,
    unassignedCandidates,
    screens,
    setMode,
    priorityChoices,
    effectivePriority,
    ensurePlan,
    pruneCustom,
    storageValid,
    request,
    loadReview,
    nameClashes,
    resetStorage,
  };
}

export type Wizard = ReturnType<typeof createWizard>;

const KEY: InjectionKey<Wizard> = Symbol('setup-wizard');

export function provideWizard(w: Wizard): void {
  provide(KEY, w);
}

export function useWizard(): Wizard {
  const w = inject(KEY);
  if (!w) throw new Error('useWizard() needs SetupView as an ancestor');
  return w;
}
