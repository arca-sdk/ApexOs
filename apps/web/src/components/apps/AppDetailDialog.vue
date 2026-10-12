<script setup lang="ts">
/**
 * Catalog app details and the install flow, in one dialog:
 * details (description, screenshots, links, requirements) → settings (questions, name) → live install progress.
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { CircleCheck, Code, ExternalLink, Globe, Info } from 'lucide-vue-next';
import type { CatalogAppDetail, InstallQuestion, InstallRequest, TaskStarted } from '@hearth/api-types';
import { ApiError, api } from '../../lib/api.ts';
import { live } from '../../lib/events.ts';
import Modal from '../Modal.vue';
import PageState from '../PageState.vue';
import TaskItem from '../notifications/TaskItem.vue';
import AppIcon from './AppIcon.vue';
import InstallQuestionField from './InstallQuestionField.vue';
import RequirementsPanel from './RequirementsPanel.vue';
import TierBadge from './TierBadge.vue';
import { categoryLabel, errorText } from './apps.ts';

const props = defineProps<{ appId: string; train?: string }>();
const emit = defineEmits<{ close: [] }>();
const router = useRouter();

type Step = 'details' | 'settings' | 'progress';
const step = ref<Step>('details');

const detail = ref<CatalogAppDetail | null>(null);
const loading = ref(true);
const loadError = ref<string | null>(null);

const answers = reactive<Record<string, string | number | boolean>>({});
const appName = ref('');
const fieldErrors = reactive<Record<string, string>>({});
const formError = ref('');
const submitting = ref(false);
const taskId = ref<string | null>(null);
const brokenShots = ref(new Set<string>());

const task = computed(() => (taskId.value ? (live.tasks[taskId.value] ?? null) : null));
const curated = computed(() => detail.value?.tier === 'curated');
const blocked = computed(() => Boolean(detail.value?.requirements && !detail.value.requirements.ok));
const screenshots = computed(() => (detail.value?.screenshots ?? []).filter((s) => !brokenShots.value.has(s)));
const sourceLinks = computed(() => {
  const home = detail.value?.homepage?.replace(/\/$/, '');
  return (detail.value?.sources ?? []).filter((s) => s.replace(/\/$/, '') !== home).slice(0, 3);
});

const title = computed(() => {
  const name = detail.value?.title ?? 'App';
  if (step.value === 'settings') return `Install ${name}`;
  if (step.value === 'progress') return task.value?.status === 'success' ? `${name} is installed` : `Installing ${name}`;
  return name;
});

function initialAnswer(q: InstallQuestion): string | number | boolean {
  if (q.default !== undefined) return q.default;
  if (q.type === 'boolean') return false;
  if (q.type === 'select' && q.required && q.options?.length) return q.options[0]!.value;
  return '';
}

/** Questions whose default the install script generated randomly can be regenerated. */
function generatable(q: InstallQuestion): boolean {
  return q.generated === true && typeof q.default === 'string';
}

async function load() {
  loading.value = true;
  loadError.value = null;
  try {
    const qs = props.train ? `?train=${encodeURIComponent(props.train)}` : '';
    const d = await api.get<CatalogAppDetail>(`/apps/catalog/${encodeURIComponent(props.appId)}${qs}`);
    detail.value = d;
    for (const q of d.questions) answers[q.key] = initialAnswer(q);
  } catch (e) {
    loadError.value = errorText(e);
  } finally {
    loading.value = false;
  }
}

const NAME_RE = /^[a-z]([-a-z0-9]*[a-z0-9])?$/;

function validate(): boolean {
  for (const k of Object.keys(fieldErrors)) delete fieldErrors[k];
  for (const q of detail.value?.questions ?? []) {
    const v = answers[q.key];
    if (q.required && q.type !== 'boolean' && (v === '' || v === undefined || (typeof v === 'number' && Number.isNaN(v)))) {
      fieldErrors[q.key] = 'This one is needed.';
    }
  }
  const name = appName.value.trim();
  if (name && (!NAME_RE.test(name) || name.length > 40)) {
    fieldErrors.appName = 'Use lowercase letters, numbers and dashes, starting with a letter (up to 40 characters).';
  }
  return Object.keys(fieldErrors).length === 0;
}

async function install() {
  if (!detail.value || !validate()) return;
  submitting.value = true;
  formError.value = '';
  const body: InstallRequest = {
    catalogApp: detail.value.id,
    train: detail.value.train,
    answers: { ...answers },
    ...(appName.value.trim() ? { appName: appName.value.trim() } : {}),
  };
  try {
    const { task: started } = await api.post<TaskStarted>('/apps/install', body);
    live.tasks[started.id] ??= started;
    taskId.value = started.id;
    step.value = 'progress';
  } catch (e) {
    if (e instanceof ApiError && Object.keys(e.fields).length) Object.assign(fieldErrors, e.fields);
    formError.value = errorText(e);
  } finally {
    submitting.value = false;
  }
}

function next() {
  // Apps without questions skip straight to the settings step anyway, to confirm the name.
  step.value = 'settings';
}

function retry() {
  taskId.value = null;
  step.value = 'settings';
  void load();
}

function goToApps() {
  emit('close');
  router.push('/apps');
}

onMounted(load);
</script>

<template>
  <Modal :title="title" wide @close="emit('close')">
    <PageState :loading="loading" :error="loadError" @retry="load">
      <template v-if="detail">
        <!-- Step 1: details -->
        <template v-if="step === 'details'">
          <div class="hero">
            <AppIcon :src="detail.icon" :title="detail.title" :size="64" />
            <div class="stack" style="--gap: 6px; min-width: 0">
              <div class="row wrap" style="--gap: 6px">
                <TierBadge :tier="detail.tier" />
                <span v-if="detail.installed" class="badge ok"><CircleCheck :size="12" aria-hidden="true" /> Installed</span>
                <span v-for="c in detail.categories" :key="c" class="badge">{{ categoryLabel(c) }}</span>
              </div>
              <span class="small muted">
                Version <span class="mono">{{ detail.appVersion || detail.version }}</span> · from the {{ detail.train }} catalog
              </span>
            </div>
          </div>

          <p class="description">{{ detail.description || 'No description provided.' }}</p>

          <div v-if="screenshots.length" class="shots" role="list" aria-label="Screenshots">
            <a
              v-for="(s, i) in screenshots"
              :key="s"
              role="listitem"
              :href="s"
              target="_blank"
              rel="noopener"
              class="shot"
              :aria-label="`Screenshot ${i + 1} of ${screenshots.length} (opens in a new tab)`"
            >
              <img :src="s" :alt="`${detail.title} screenshot ${i + 1}`" loading="lazy" referrerpolicy="no-referrer" @error="brokenShots = new Set([...brokenShots, s])" />
            </a>
          </div>

          <div v-if="detail.homepage || sourceLinks.length" class="row wrap links" style="--gap: 8px 16px">
            <a v-if="detail.homepage" :href="detail.homepage" target="_blank" rel="noopener" class="row small" style="--gap: 6px">
              <Globe :size="15" aria-hidden="true" /> Website <ExternalLink :size="12" aria-hidden="true" />
            </a>
            <a v-for="src in sourceLinks" :key="src" :href="src" target="_blank" rel="noopener" class="row small source" style="--gap: 6px" :title="src">
              <Code :size="15" aria-hidden="true" />
              {{ src.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '') }}
            </a>
          </div>

          <RequirementsPanel v-if="detail.requirements" :req="detail.requirements" />
          <div v-else class="callout small tier-note">
            <Info :size="16" aria-hidden="true" />
            <span>
              This app comes straight from the TrueNAS catalog. Hearth installs it with its standard settings, so you may need to finish setting
              it up inside the app itself. Its data is kept in the app's own storage, not in your shared folders.
            </span>
          </div>

          <p v-if="detail.installed && !blocked" class="small muted">
            You already have this app. Installing it again adds a second, separate copy.
          </p>
        </template>

        <!-- Step 2: settings -->
        <form v-else-if="step === 'settings'" id="install-form" class="stack" novalidate @submit.prevent="install">
          <p v-if="curated" class="muted small">
            Hearth sets up folders, permissions and ports for you. Check the settings below, or just press Install.
          </p>
          <p v-else class="muted small">This app will be installed with the catalog's standard settings.</p>

          <InstallQuestionField
            v-for="q in detail.questions"
            :key="q.key"
            v-model="answers[q.key]"
            :question="q"
            :error="fieldErrors[q.key]"
            :generatable="generatable(q)"
          />

          <details class="advanced" :open="Boolean(fieldErrors.appName) || undefined">
            <summary>App name</summary>
            <div class="field">
              <label for="install-app-name">Name on your server <span class="muted">(optional)</span></label>
              <input
                id="install-app-name"
                v-model="appName"
                type="text"
                autocomplete="off"
                spellcheck="false"
                :placeholder="detail.suggestedName"
                aria-describedby="install-app-name-hint"
                :aria-invalid="!!fieldErrors.appName"
              />
              <span id="install-app-name-hint" class="hint">
                TrueNAS uses this to tell apps apart. Leave it empty to use <code>{{ detail.suggestedName }}</code>.
              </span>
              <span v-if="fieldErrors.appName" class="error-text">{{ fieldErrors.appName }}</span>
            </div>
          </details>

          <p v-if="formError" class="callout err" role="alert">{{ formError }}</p>
        </form>

        <!-- Step 3: progress -->
        <div v-else class="stack" aria-live="polite">
          <div v-if="task" class="card flat progress-card">
            <TaskItem :task="task" show-steps />
          </div>
          <p v-else class="row muted"><span class="spin" /> Starting…</p>
          <p v-if="task?.status === 'running'" class="small muted">
            This can take a few minutes while the app downloads. You can close this window; the install keeps going and you'll get a
            notification when it's done.
          </p>
          <p v-else-if="task?.status === 'success'" class="callout ok">{{ detail.title }} is installed and starting up. Find it on your Apps page.</p>
          <p v-else-if="task?.status === 'failed'" class="callout err">
            The install didn't finish. Check the message above, then go back to adjust the settings and try again.
          </p>
        </div>
      </template>
    </PageState>

    <template #footer>
      <template v-if="step === 'details'">
        <button class="btn" @click="emit('close')">Close</button>
        <button v-if="detail" class="btn primary" :disabled="blocked" :title="blocked ? 'This server does not meet the requirements' : undefined" @click="next">
          {{ detail.installed ? 'Install another copy' : 'Install' }}
        </button>
      </template>
      <template v-else-if="step === 'settings'">
        <button class="btn" type="button" @click="step = 'details'">Back</button>
        <button class="btn primary" type="submit" form="install-form" :disabled="submitting">
          <span v-if="submitting" class="spin" /> Install
        </button>
      </template>
      <template v-else>
        <template v-if="task?.status === 'failed'">
          <button class="btn" @click="emit('close')">Close</button>
          <button class="btn primary" @click="retry">Back to settings</button>
        </template>
        <template v-else-if="task?.status === 'success'">
          <button class="btn" @click="emit('close')">Done</button>
          <button class="btn primary" @click="goToApps">Go to my apps</button>
        </template>
        <button v-else class="btn" @click="emit('close')">Hide</button>
      </template>
    </template>
  </Modal>
</template>

<style scoped>
.hero {
  display: flex;
  align-items: center;
  gap: 16px;
}
.description {
  white-space: pre-line;
  overflow-wrap: anywhere;
}
.shots {
  display: flex;
  gap: 10px;
  overflow-x: auto;
  padding-bottom: 6px;
  scroll-snap-type: x mandatory;
}
.shot {
  flex: none;
  scroll-snap-align: start;
  border-radius: var(--radius-sm);
  overflow: hidden;
  border: 1px solid var(--border);
  background: var(--surface-2);
  width: min(280px, 75vw);
  aspect-ratio: 16 / 10;
}
.shot img {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
}
.links a {
  font-weight: 550;
}
.source {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tier-note {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}
.tier-note svg {
  flex: none;
  margin-top: 2px;
  color: var(--info);
}
.advanced {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 10px 14px;
}
.advanced summary {
  cursor: pointer;
  font-weight: 550;
  font-size: 0.92rem;
}
.advanced[open] summary {
  margin-bottom: 12px;
}
.progress-card {
  padding: 16px;
}
</style>
