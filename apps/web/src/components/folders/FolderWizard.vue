<script setup lang="ts">
/**
 * Create / edit folder wizard: General → Access → Options → Encryption → Review.
 * In edit mode the name, pool and encryption are shown read-only (encryption changes live on the folder page).
 */
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';
import { Check, Globe, KeyRound, Lock, ShieldCheck, ShieldOff, UserPlus } from 'lucide-vue-next';
import type { AccessLevel, EncryptionMode, Folder, FolderAccess, FolderRequest, Pool, ShareUser, StorageOverview, TaskStarted } from '@apexos/api-types';
import Modal from '../Modal.vue';
import HealthBadge from '../HealthBadge.vue';
import PasswordInput from '../users/PasswordInput.vue';
import PassphraseFields from './PassphraseFields.vue';
import { MODE_LABELS, passphraseProblem } from './encryptionRules.ts';
import { ApiError, api, runTask } from '../../lib/api.ts';
import { formatBytes } from '../../lib/format.ts';
import {
  FOLDER_NAME_MAX,
  LEVEL_LABELS,
  MIN_QUOTA_BYTES,
  USERNAME_MAX,
  folderNameProblem,
  passwordProblem,
  quotaToBytes,
  splitQuota,
  usernameProblem,
} from './folderRules.ts';

const props = defineProps<{
  /** Present in edit mode. */
  folder?: Folder | null;
  existingNames: string[];
  reservedNames: string[];
}>();
const emit = defineEmits<{ close: []; done: [name: string] }>();

const editing = computed(() => !!props.folder);
const STEPS = ['General', 'Access', 'Options', 'Encryption', 'Review'] as const;
const step = ref(0);
const furthest = ref(props.folder ? STEPS.length - 1 : 0);
const stepHeading = ref<HTMLElement | null>(null);

// ---- data -------------------------------------------------------------------
const loading = ref(true);
const loadError = ref('');
const pools = ref<Pool[]>([]);
const users = ref<ShareUser[]>([]);

async function load() {
  loading.value = true;
  loadError.value = '';
  try {
    const [storage, list] = await Promise.all([
      editing.value ? Promise.resolve<StorageOverview | null>(null) : api.get<StorageOverview>('/storage'),
      api.get<ShareUser[]>('/users'),
    ]);
    if (storage) {
      pools.value = storage.pools;
      const usable = storage.pools.filter((p) => p.health !== 'offline');
      if (!form.pool && usable.length === 1) form.pool = usable[0]!.name;
    }
    users.value = list;
    for (const u of list) form.levels[u.username] ??= 'none';
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

// ---- form -------------------------------------------------------------------
type Level = AccessLevel | 'none';
const initialQuota = props.folder?.quotaBytes ? splitQuota(props.folder.quotaBytes) : null;

const form = reactive({
  name: props.folder?.name ?? '',
  pool: props.folder?.pool ?? '',
  access: (props.folder?.access ?? 'private') as FolderAccess,
  levels: Object.fromEntries((props.folder?.users ?? []).map((u) => [u.username, u.level])) as Record<string, Level>,
  quotaOn: !!props.folder?.quotaBytes,
  quotaValue: initialQuota?.value ?? 100,
  quotaUnit: initialQuota?.unit ?? ('GB' as 'GB' | 'TB'),
  timeMachine: props.folder?.timeMachine ?? false,
  /** New folders default to an automatic key (recommended). */
  encryption: (props.folder?.encryption?.mode ?? 'key') as EncryptionMode,
  passphrase: '',
  passphraseAgain: '',
  passphraseAck: false,
});

const errors = reactive<Record<string, string>>({});
const submitError = ref('');
const busy = ref(false);

watch(
  () => form.access,
  (a) => {
    if (a === 'public') form.timeMachine = false;
  },
);

const selectedPool = computed(() => pools.value.find((p) => p.name === form.pool) ?? null);
const poolLabel = computed(() => props.folder?.poolDisplayName ?? selectedPool.value?.displayName ?? form.pool);

const grantedUsers = computed(() =>
  Object.entries(form.levels)
    .filter((e): e is [string, AccessLevel] => e[1] !== 'none' && users.value.some((u) => u.username === e[0]))
    .map(([username, level]) => ({ username, level })),
);

const quotaBytes = computed<number | null>(() => {
  if (!form.quotaOn) return null;
  if (initialQuota && props.folder?.quotaBytes && form.quotaValue === initialQuota.value && form.quotaUnit === initialQuota.unit) {
    return props.folder.quotaBytes; // unchanged: keep the exact value so nothing is rewritten
  }
  return quotaToBytes(Number(form.quotaValue) || 0, form.quotaUnit);
});
const quotaBelowUsage = computed(() => !!props.folder && quotaBytes.value !== null && quotaBytes.value < props.folder.usedBytes);

// ---- validation ---------------------------------------------------------------
function clearErrors(keys: string[]) {
  for (const k of keys) delete errors[k];
}

function validateStep(i: number): boolean {
  if (i === 0) {
    clearErrors(['name', 'pool']);
    if (!editing.value) {
      const nameProblem = folderNameProblem(form.name, props.reservedNames, props.existingNames);
      if (nameProblem) errors.name = nameProblem;
      if (!form.pool) errors.pool = pools.value.length ? 'Choose where to keep the folder.' : 'Create a storage pool first.';
    }
    return !errors.name && !errors.pool;
  }
  if (i === 2) {
    clearErrors(['quotaBytes', 'timeMachine']);
    if (form.quotaOn) {
      const v = Number(form.quotaValue);
      if (!Number.isFinite(v) || v <= 0) errors.quotaBytes = 'Enter how much space the folder may use.';
      else if ((quotaBytes.value ?? 0) < MIN_QUOTA_BYTES) errors.quotaBytes = 'The smallest limit is 1.1 GB.';
    }
    if (form.timeMachine && form.access !== 'private') errors.timeMachine = 'Only private folders can hold Time Machine backups.';
    return !errors.quotaBytes && !errors.timeMachine;
  }
  if (i === 3 && !editing.value) {
    clearErrors(['encryption', 'passphrase', 'passphraseAgain', 'passphraseAck']);
    if (form.encryption === 'passphrase') {
      const problem = passphraseProblem(form.passphrase, form.passphraseAgain);
      if (problem.passphrase) errors.passphrase = problem.passphrase;
      if (problem.again) errors.passphraseAgain = problem.again;
      if (!form.passphraseAck) errors.passphraseAck = 'Tick this to confirm you’ll keep the passphrase safe.';
    }
    return !errors.passphrase && !errors.passphraseAgain && !errors.passphraseAck && !errors.encryption;
  }
  return true;
}

const passphraseErrors = computed(() => ({ passphrase: errors.passphrase, again: errors.passphraseAgain }));
function clearPassphraseErrors() {
  clearErrors(['passphrase', 'passphraseAgain', 'encryption']);
}

async function goTo(i: number) {
  if (i > step.value) {
    for (let s = step.value; s < i; s++) {
      if (!validateStep(s)) {
        step.value = s;
        return;
      }
    }
    // Moving on means the user dealt with whatever the last attempt complained about.
    submitError.value = '';
  }
  step.value = i;
  furthest.value = Math.max(furthest.value, i);
  await nextTick();
  stepHeading.value?.focus();
}

function next() {
  if (step.value < STEPS.length - 1) goTo(step.value + 1);
  else submit();
}

// ---- inline "add a user" (Access step) -----------------------------------------
const adding = ref(false);
const newUser = reactive({ username: '', password: '', error: '', fields: {} as Record<string, string>, busy: false });

async function addUser() {
  newUser.error = '';
  newUser.fields = {};
  const uProblem = usernameProblem(newUser.username, users.value.map((u) => u.username));
  const pProblem = passwordProblem(newUser.password);
  if (uProblem) newUser.fields.username = uProblem;
  if (pProblem) newUser.fields.password = pProblem;
  if (uProblem || pProblem) return;
  newUser.busy = true;
  try {
    const created = await api.post<ShareUser>('/users', { username: newUser.username.trim(), password: newUser.password });
    users.value = [...users.value, created].sort((a, b) => a.username.localeCompare(b.username));
    form.levels[created.username] = 'full';
    newUser.username = newUser.password = '';
    adding.value = false;
  } catch (e) {
    if (e instanceof ApiError) {
      newUser.fields = { ...e.fields };
      if (!Object.keys(e.fields).length) newUser.error = e.message;
    } else newUser.error = String(e);
  } finally {
    newUser.busy = false;
  }
}

// ---- submit -------------------------------------------------------------------
const FIELD_STEP: Record<string, number> = { name: 0, pool: 0, access: 1, users: 1, quotaBytes: 2, timeMachine: 2, encryption: 3 };

async function submit() {
  for (let s = 0; s < STEPS.length - 1; s++) {
    if (!validateStep(s)) return goTo(s);
  }
  submitError.value = '';
  busy.value = true;
  const body: Omit<FolderRequest, 'name' | 'pool'> = {
    access: form.access,
    users: form.access === 'private' ? grantedUsers.value : [],
    quotaBytes: quotaBytes.value,
    timeMachine: form.access === 'private' && form.timeMachine,
  };
  try {
    if (props.folder) {
      await runTask(api.put<TaskStarted>(`/folders/${encodeURIComponent(props.folder.name)}`, body));
      emit('done', props.folder.name);
    } else {
      const name = form.name.trim();
      const encryption = form.encryption === 'passphrase' ? { mode: form.encryption, passphrase: form.passphrase } : { mode: form.encryption };
      await runTask(api.post<TaskStarted>('/folders', { name, pool: form.pool, ...body, encryption } satisfies FolderRequest));
      form.passphrase = form.passphraseAgain = '';
      emit('done', name);
    }
  } catch (e) {
    if (e instanceof ApiError && Object.keys(e.fields).length) {
      let first = STEPS.length - 1;
      for (const [key, msg] of Object.entries(e.fields)) {
        const root = key.split('.')[0]!;
        errors[root] = msg;
        first = Math.min(first, FIELD_STEP[root] ?? first);
      }
      submitError.value = e.message;
      if (first < STEPS.length - 1) await goTo(first);
    } else {
      submitError.value = e instanceof Error ? e.message : String(e);
    }
  } finally {
    busy.value = false;
  }
}

const title = computed(() => (props.folder ? `Edit ${props.folder.name}` : 'New folder'));
const primaryLabel = computed(() => (step.value < STEPS.length - 1 ? 'Next' : props.folder ? 'Save changes' : 'Create folder'));

onMounted(load);
</script>

<template>
  <Modal :title="title" wide @close="emit('close')">
    <ol class="steps" aria-label="Steps">
      <li v-for="(label, i) in STEPS" :key="label">
        <button
          type="button"
          class="step"
          :class="{ current: i === step, done: i < step || (editing && i !== step) }"
          :aria-current="i === step ? 'step' : undefined"
          :disabled="i > furthest || busy"
          @click="goTo(i)"
        >
          <span class="num"><Check v-if="i < step" :size="12" /><template v-else>{{ i + 1 }}</template></span>
          <span class="label">{{ label }}</span>
        </button>
      </li>
    </ol>

    <div v-if="loading" class="row muted"><span class="spin" /> Loading…</div>
    <div v-else-if="loadError" class="callout err stack" style="--gap: 8px">
      <span>Couldn’t load what this form needs: {{ loadError }}</span>
      <div><button class="btn small" @click="load">Try again</button></div>
    </div>

    <form v-else id="folder-wizard" class="stack" novalidate @submit.prevent="next">
      <h3 ref="stepHeading" tabindex="-1" class="step-heading">
        {{ ['Name and place', 'Who can open it', 'Options', 'Protect it with encryption', 'Check and confirm'][step] }}
      </h3>

      <p v-if="submitError && step !== STEPS.length - 1" class="callout err" role="alert">{{ submitError }}</p>

      <!-- General -->
      <template v-if="step === 0">
        <div class="field">
          <label for="fw-name">Folder name</label>
          <input
            v-if="!editing"
            id="fw-name"
            v-model="form.name"
            type="text"
            :maxlength="FOLDER_NAME_MAX"
            autocomplete="off"
            spellcheck="false"
            placeholder="e.g. Family Photos"
            :aria-invalid="!!errors.name || undefined"
            aria-describedby="fw-name-hint fw-name-err"
            @input="delete errors.name"
          />
          <input v-else id="fw-name" class="readonly" type="text" readonly :value="form.name" aria-describedby="fw-name-hint" />
          <span id="fw-name-hint" class="hint">
            {{ editing ? 'A folder’s name can’t be changed after it’s created.' : 'Letters, numbers, spaces, dashes and underscores. You can’t rename it later, so pick a name you’ll keep.' }}
          </span>
          <span v-if="errors.name" id="fw-name-err" class="error-text">{{ errors.name }}</span>
        </div>

        <fieldset class="field plain">
          <legend class="field-label">Where to keep it</legend>
          <p v-if="editing" class="readonly">{{ poolLabel }}</p>
          <template v-else-if="pools.length">
            <label
              v-for="p in pools"
              :key="p.name"
              class="choice"
              :class="{ selected: form.pool === p.name, disabled: p.health === 'offline' }"
            >
              <input v-model="form.pool" type="radio" name="fw-pool" :value="p.name" :disabled="p.health === 'offline'" @change="delete errors.pool" />
              <span class="stack" style="--gap: 2px; flex: 1">
                <span class="row wrap" style="--gap: 8px">
                  <strong>{{ p.displayName }}</strong>
                  <HealthBadge v-if="p.health !== 'healthy'" :health="p.health" />
                </span>
                <span class="small muted">{{ formatBytes(p.freeBytes) }} free{{ p.kind === 'performance' ? ' · fast (SSD)' : p.kind === 'capacity' ? ' · large (hard drives)' : '' }}</span>
              </span>
            </label>
          </template>
          <p v-else class="callout warn">
            You need a storage pool before you can create folders. <RouterLink to="/storage">Set up storage</RouterLink>
          </p>
          <span class="hint">{{ editing ? 'A folder stays on the pool it was created on.' : pools.length === 1 ? 'You have one pool, so it’s picked for you. This can’t be changed later.' : 'This can’t be changed later.' }}</span>
          <span v-if="errors.pool" class="error-text">{{ errors.pool }}</span>
        </fieldset>
      </template>

      <!-- Access -->
      <template v-else-if="step === 1">
        <fieldset class="field plain">
          <legend class="sr-only">Access</legend>
          <label class="choice" :class="{ selected: form.access === 'public' }">
            <input v-model="form.access" type="radio" name="fw-access" value="public" />
            <Globe :size="18" class="choice-icon" />
            <span class="stack" style="--gap: 2px">
              <strong>Public</strong>
              <span class="small muted">Everyone on your home network can open, add, change and delete files. No password needed.</span>
            </span>
          </label>
          <label class="choice" :class="{ selected: form.access === 'private' }">
            <input v-model="form.access" type="radio" name="fw-access" value="private" />
            <Lock :size="18" class="choice-icon" />
            <span class="stack" style="--gap: 2px">
              <strong>Private</strong>
              <span class="small muted">Only the people you pick. Each person signs in with their own username and password.</span>
            </span>
          </label>
        </fieldset>

        <div v-if="form.access === 'private'" class="stack" style="--gap: 10px">
          <h4>People</h4>
          <p class="small muted">The server’s admin account always has full access. Choose what everyone else can do.</p>
          <ul v-if="users.length" class="people">
            <li v-for="u in users" :key="u.id" class="row" style="--gap: 10px">
              <label :for="`fw-level-${u.id}`" class="person">{{ u.username }}</label>
              <span class="spacer" />
              <select :id="`fw-level-${u.id}`" v-model="form.levels[u.username]" class="level">
                <option value="none">No access</option>
                <option value="read">{{ LEVEL_LABELS.read }}</option>
                <option value="full">{{ LEVEL_LABELS.full }}</option>
              </select>
            </li>
          </ul>
          <p v-else class="callout">
            There are no users yet, so only the admin account could open this folder. Add a user below to share it with someone.
          </p>
          <p v-if="errors.users" class="error-text small">{{ errors.users }}</p>

          <div v-if="adding" class="card flat stack add-user" style="--gap: 12px">
            <strong>New user</strong>
            <div class="field">
              <label for="fw-nu-name">Username</label>
              <input
                id="fw-nu-name"
                v-model="newUser.username"
                type="text"
                :maxlength="USERNAME_MAX"
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
                data-1p-ignore
                data-lpignore="true"
                :aria-invalid="!!newUser.fields.username || undefined"
                @keydown.enter.prevent="addUser"
              />
              <span v-if="newUser.fields.username" class="error-text">{{ newUser.fields.username }}</span>
            </div>
            <div class="field">
              <label for="fw-nu-pass">Password</label>
              <PasswordInput id="fw-nu-pass" v-model="newUser.password" :invalid="!!newUser.fields.password" @keydown.enter.prevent="addUser" />
              <span class="hint">At least 8 characters. They’ll use it when their computer asks for a password.</span>
              <span v-if="newUser.fields.password" class="error-text">{{ newUser.fields.password }}</span>
            </div>
            <p v-if="newUser.error" class="callout err">{{ newUser.error }}</p>
            <div class="row" style="--gap: 8px">
              <button type="button" class="btn primary small" :disabled="newUser.busy" @click="addUser">
                <span v-if="newUser.busy" class="spin" /> Add user
              </button>
              <button type="button" class="btn small" @click="adding = false">Cancel</button>
            </div>
          </div>
          <div v-else>
            <button type="button" class="btn small" @click="adding = true"><UserPlus :size="16" /> Add a user</button>
          </div>
        </div>
      </template>

      <!-- Options -->
      <template v-else-if="step === 2">
        <div class="stack" style="--gap: 10px">
          <label class="row check">
            <input v-model="form.quotaOn" type="checkbox" @change="delete errors.quotaBytes" />
            <span class="stack" style="--gap: 2px">
              <strong>Limit how much space it can use</strong>
              <span class="small muted">Handy for backups, which otherwise grow until the pool is full.</span>
            </span>
          </label>
          <div v-if="form.quotaOn" class="field quota">
            <label for="fw-quota">Storage limit</label>
            <div class="row" style="--gap: 8px">
              <input
                id="fw-quota"
                v-model.number="form.quotaValue"
                type="number"
                min="1"
                step="any"
                inputmode="decimal"
                :aria-invalid="!!errors.quotaBytes || undefined"
                @input="delete errors.quotaBytes"
              />
              <select v-model="form.quotaUnit" aria-label="Unit" class="unit">
                <option value="GB">GB</option>
                <option value="TB">TB</option>
              </select>
            </div>
            <span v-if="!editing && selectedPool" class="hint">{{ selectedPool.displayName }} has {{ formatBytes(selectedPool.freeBytes) }} free.</span>
            <span v-if="errors.quotaBytes" class="error-text">{{ errors.quotaBytes }}</span>
            <p v-if="quotaBelowUsage" class="callout warn small">
              This folder already holds {{ formatBytes(folder!.usedBytes) }}. With a smaller limit it counts as full, and nothing new can be saved until files are removed.
            </p>
          </div>
        </div>

        <div class="stack" style="--gap: 6px">
          <label class="row check" :class="{ disabled: form.access !== 'private' }">
            <input v-model="form.timeMachine" type="checkbox" :disabled="form.access !== 'private'" />
            <span class="stack" style="--gap: 2px">
              <strong>Use for Time Machine backups</strong>
              <span class="small muted">
                {{ form.access === 'private' ? 'Macs on your network can pick this folder as their backup disk. Setting a storage limit is a good idea.' : 'Only private folders can hold Time Machine backups.' }}
              </span>
            </span>
          </label>
          <span v-if="errors.timeMachine" class="error-text small">{{ errors.timeMachine }}</span>
        </div>
      </template>

      <!-- Encryption -->
      <template v-else-if="step === 3">
        <template v-if="editing">
          <p class="readonly">{{ MODE_LABELS[folder?.encryption?.mode ?? 'none'] }}</p>
          <p class="small muted">Encryption is changed from the folder’s page, in its Encryption section.</p>
        </template>
        <template v-else>
          <p class="small muted">Encryption scrambles the files on the drives, so nobody can read them from a drive that is pulled out, sold or thrown away.</p>
          <fieldset class="field plain">
            <legend class="sr-only">Encryption</legend>
            <label class="choice" :class="{ selected: form.encryption === 'key' }">
              <input v-model="form.encryption" type="radio" name="fw-enc" value="key" @change="clearPassphraseErrors" />
              <ShieldCheck :size="18" class="choice-icon" />
              <span class="stack" style="--gap: 2px">
                <strong>Automatic key <span class="badge ok">Recommended</span></strong>
                <span class="small muted">The server keeps the key and unlocks the folder by itself when it starts, so it works like any other folder. Keep a recovery file (Settings → Recovery key) in case the server’s system drive fails.</span>
              </span>
            </label>
            <label class="choice" :class="{ selected: form.encryption === 'passphrase' }">
              <input v-model="form.encryption" type="radio" name="fw-enc" value="passphrase" @change="clearPassphraseErrors" />
              <KeyRound :size="18" class="choice-icon" />
              <span class="stack" style="--gap: 2px">
                <strong>Passphrase</strong>
                <span class="small muted">After every restart the folder stays locked until you type the passphrase, so even someone who takes the whole server can’t open it. ApexOs never stores the passphrase.</span>
              </span>
            </label>
            <label class="choice" :class="{ selected: form.encryption === 'none' }">
              <input v-model="form.encryption" type="radio" name="fw-enc" value="none" @change="clearPassphraseErrors" />
              <ShieldOff :size="18" class="choice-icon" />
              <span class="stack" style="--gap: 2px">
                <strong>Don’t encrypt</strong>
                <span class="small muted">Files are stored as they are. You can turn encryption on later; that makes a full copy of the folder, so it takes longer once it holds a lot.</span>
              </span>
            </label>
          </fieldset>

          <div v-if="form.encryption === 'passphrase'" class="card flat stack passphrase" style="--gap: 12px">
            <PassphraseFields id-prefix="fw-enc" v-model:passphrase="form.passphrase" v-model:again="form.passphraseAgain" :errors="passphraseErrors" @input="clearPassphraseErrors" />
            <label class="row check">
              <input v-model="form.passphraseAck" type="checkbox" :aria-invalid="!!errors.passphraseAck || undefined" @change="delete errors.passphraseAck" />
              <span class="small">I’ll keep this passphrase somewhere safe. If it’s lost, nobody can open these files again, not even with a recovery file.</span>
            </label>
            <span v-if="errors.passphraseAck" class="error-text small">{{ errors.passphraseAck }}</span>
          </div>
          <p v-if="errors.encryption" class="error-text small">{{ errors.encryption }}</p>
        </template>
      </template>

      <!-- Review -->
      <template v-else>
        <div class="review">
          <section class="card flat stack" style="--gap: 6px">
            <div class="row"><h4>General</h4><span class="spacer" /><button v-if="!editing" type="button" class="btn ghost small" @click="goTo(0)">Change</button></div>
            <p><strong>{{ form.name.trim() }}</strong> <span class="muted">on {{ poolLabel }}</span></p>
          </section>
          <section class="card flat stack" style="--gap: 6px">
            <div class="row"><h4>Access</h4><span class="spacer" /><button type="button" class="btn ghost small" @click="goTo(1)">Change</button></div>
            <p v-if="form.access === 'public'">Public: everyone on your network has full access.</p>
            <template v-else>
              <p>Private</p>
              <ul class="small review-list">
                <li>Admin account: Full access</li>
                <li v-for="u in grantedUsers" :key="u.username">{{ u.username }}: {{ LEVEL_LABELS[u.level] }}</li>
              </ul>
            </template>
          </section>
          <section class="card flat stack" style="--gap: 6px">
            <div class="row"><h4>Options</h4><span class="spacer" /><button type="button" class="btn ghost small" @click="goTo(2)">Change</button></div>
            <p class="small">Storage limit: {{ quotaBytes ? formatBytes(quotaBytes) : 'None' }}</p>
            <p class="small">Time Machine: {{ form.access === 'private' && form.timeMachine ? 'On' : 'Off' }}</p>
          </section>
          <section class="card flat stack" style="--gap: 6px">
            <div class="row"><h4>Encryption</h4><span class="spacer" /><button v-if="!editing" type="button" class="btn ghost small" @click="goTo(3)">Change</button></div>
            <p class="small">{{ MODE_LABELS[form.encryption] }}</p>
            <p v-if="!editing && form.encryption === 'passphrase'" class="small muted">The folder stays locked after every restart until someone types the passphrase.</p>
            <p v-else-if="!editing && form.encryption === 'key'" class="small muted">Unlocks by itself when the server starts. Download a new recovery file afterwards.</p>
          </section>
        </div>
        <p class="small muted">
          {{ editing ? 'Saving updates the sharing settings. Files in the folder aren’t touched.' : 'ApexOs creates the folder and shares it on your network. This takes a few seconds.' }}
        </p>
        <p v-if="submitError" class="callout err" role="alert">{{ submitError }}</p>
      </template>
    </form>

    <template #footer>
      <button v-if="step > 0" type="button" class="btn" :disabled="busy" @click="goTo(step - 1)">Back</button>
      <button v-else type="button" class="btn" @click="emit('close')">Cancel</button>
      <button
        type="submit"
        form="folder-wizard"
        class="btn primary"
        :disabled="busy || loading || !!loadError || (step === 0 && !editing && !pools.length)"
      >
        <span v-if="busy" class="spin" />
        {{ busy ? (editing ? 'Saving…' : 'Creating…') : primaryLabel }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.steps {
  list-style: none;
  margin: 0 0 4px;
  padding: 0;
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.step {
  appearance: none;
  border: 0;
  background: transparent;
  font: inherit;
  color: var(--text-muted);
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px 4px 4px;
  border-radius: 999px;
  cursor: pointer;
  font-size: 0.88rem;
  font-weight: 550;
}
.step:disabled {
  cursor: default;
  opacity: 0.6;
}
.step:focus-visible {
  outline: 2px solid var(--accent);
}
.step .num {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--surface-2);
  border: 1px solid var(--border);
  font-size: 0.78rem;
}
.step.current {
  color: var(--text);
  background: var(--accent-soft);
}
.step.current .num {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
}
.step.done .num {
  background: var(--ok-soft);
  border-color: var(--ok);
  color: var(--ok);
}
.step-heading {
  outline: none;
}
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
.readonly {
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  border: 1px solid var(--border);
  overflow-wrap: anywhere;
}
.choice {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  margin-bottom: 8px;
}
.choice input {
  margin-top: 3px;
  flex-shrink: 0;
}
.choice.selected {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.choice.disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.choice-icon {
  margin-top: 2px;
  flex-shrink: 0;
  color: var(--text-muted);
}
.people {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.people li {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}
.people li:last-child {
  border-bottom: 0;
}
.person {
  font-weight: 550;
  overflow-wrap: anywhere;
}
.level {
  width: auto;
  min-width: 140px;
}
.add-user {
  padding: 16px;
  background: var(--surface-2);
}
.passphrase {
  padding: 16px;
  background: var(--surface-2);
}
.choice strong .badge {
  margin-left: 6px;
  vertical-align: 1px;
}
.check {
  align-items: flex-start;
  --gap: 10px;
  cursor: pointer;
}
.check input {
  margin-top: 3px;
  flex-shrink: 0;
}
.check.disabled {
  cursor: not-allowed;
  opacity: 0.7;
}
.quota {
  padding-left: 26px;
  max-width: 360px;
}
.quota input {
  flex: 1;
}
.unit {
  width: auto;
}
.review {
  display: grid;
  gap: 12px;
}
.review .card {
  padding: 14px 16px;
}
.review-list {
  margin: 0;
  padding-left: 18px;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
@media (max-width: 520px) {
  .step .label {
    display: none;
  }
  .step.current .label {
    display: inline;
  }
  .quota {
    padding-left: 0;
  }
  .level {
    min-width: 0;
  }
}
.error-text {
  color: var(--err);
}
</style>
