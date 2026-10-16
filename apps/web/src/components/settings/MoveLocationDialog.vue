<script setup lang="ts">
/**
 * Moves a location's folder, with all its files, to another pool. The server copies it while everything keeps
 * running, then stops the apps using it for the last changes and swaps the copy in; this dialog shows what that
 * involves (or why it can't start), lets the user pick the pool, and follows the run.
 */
import { computed, onMounted, ref } from 'vue';
import { TriangleAlert } from 'lucide-vue-next';
import type { LocationInfo, LocationMoveCheck, TaskStarted } from '@apexos/api-types';
import Modal from '../Modal.vue';
import TaskItem from '../notifications/TaskItem.vue';
import { useTaskRunner } from '../storage/taskRunner.ts';
import { DURATION_LABELS } from '../folders/encryptionRules.ts';
import { api } from '../../lib/api.ts';
import { formatBytes } from '../../lib/format.ts';

const props = defineProps<{ location: LocationInfo }>();
const emit = defineEmits<{ close: []; done: [] }>();

const check = ref<LocationMoveCheck | null>(null);
const loadError = ref<string | null>(null);
const choice = ref<string | null>(null);
const runner = useTaskRunner(() => emit('done'));

onMounted(async () => {
  try {
    check.value = await api.get<LocationMoveCheck>(`/locations/${encodeURIComponent(props.location.id)}/move`);
    choice.value = check.value.targets.find((t) => !t.problem)?.name ?? null;
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e);
  }
});

const others = computed(() => (check.value?.locations ?? []).filter((n) => n !== props.location.name));
const list = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? ''));
const canMove = computed(() => Boolean(check.value && !check.value.blockers.length && choice.value && !runner.running.value));

function move() {
  if (!canMove.value) return;
  void runner.start(api.post<TaskStarted>(`/locations/${encodeURIComponent(props.location.id)}/move`, { pool: choice.value }));
}
</script>

<template>
  <Modal :title="check ? `Move ${check.folder} to another pool` : `Move ${location.name}`" wide @close="emit('close')">
    <div v-if="runner.task.value" class="stack" style="--gap: 12px" aria-live="polite">
      <div class="card flat"><TaskItem :task="runner.task.value" show-steps /></div>
      <p class="small muted">This can take a while for big folders. You can close this window; the move keeps going and you’ll get a notification.</p>
    </div>
    <p v-else-if="loadError" class="callout err">{{ loadError }}</p>
    <div v-else-if="!check" class="row muted" role="status"><span class="spin" /> Checking {{ location.name }}…</div>

    <div v-else-if="check.blockers.length" class="stack" style="--gap: 12px">
      <p>{{ check.folder }} can’t be moved right now:</p>
      <ul class="blockers">
        <li v-for="b in check.blockers" :key="b.code + b.message" class="row" style="--gap: 10px">
          <TriangleAlert :size="16" class="warn-icon" />
          <span>{{ b.message }}</span>
        </li>
      </ul>
    </div>

    <div v-else class="stack" style="--gap: 16px">
      <p>
        <template v-if="check.folder !== location.name">{{ location.name }} is inside the {{ check.folder }} folder, so </template>
        {{ check.folder }} ({{ formatBytes(check.usedBytes) }}) moves from {{ check.poolDisplayName }} with all its files<template v-if="others.length">,
        including {{ list(others) }}</template>. Its network share keeps its name and who can open it, and apps find their files at the new place.
      </p>
      <dl class="facts small">
        <dt>Expected time</dt>
        <dd>{{ DURATION_LABELS[check.duration] }}</dd>
        <dt>Interruption</dt>
        <dd>
          <template v-if="check.apps.length">{{ list(check.apps) }} {{ check.apps.length === 1 ? 'stops' : 'stop' }} and the share pauses</template>
          <template v-else>The share pauses</template>
          while the last changes are copied, near the end.
        </dd>
        <dt>Old copy</dt>
        <dd>Kept, hidden, on {{ check.poolDisplayName }} for a week, then removed</dd>
      </dl>

      <ul v-if="check.notes.length" class="notes small">
        <li v-for="n in check.notes" :key="n" class="row" style="--gap: 8px"><TriangleAlert :size="14" class="warn-icon" /> <span>{{ n }}</span></li>
      </ul>

      <fieldset class="field plain">
        <legend class="field-label">Move to</legend>
        <label v-for="t in check.targets" :key="t.name" class="choice" :class="{ selected: choice === t.name, disabled: !!t.problem }">
          <input v-model="choice" type="radio" name="move-pool" :value="t.name" :disabled="!!t.problem" />
          <span class="stack" style="--gap: 2px; flex: 1">
            <strong>{{ t.displayName }}</strong>
            <span class="small muted">{{ formatBytes(t.freeBytes) }} free{{ t.kind === 'performance' ? ' · fast (SSD)' : t.kind === 'capacity' ? ' · large (hard drives)' : '' }}</span>
            <span v-if="t.problem" class="small warn-text">{{ t.problem }}</span>
          </span>
        </label>
        <p v-if="!check.targets.length" class="callout warn">
          There’s no other pool to move it to. <RouterLink to="/storage">Create a pool</RouterLink> first.
        </p>
      </fieldset>
      <p v-if="runner.error.value" class="callout err" role="alert">{{ runner.error.value }}</p>
    </div>

    <template #footer>
      <button v-if="runner.task.value" class="btn primary" @click="emit('close')">{{ runner.task.value.status === 'running' ? 'Close' : 'Done' }}</button>
      <template v-else>
        <button class="btn" @click="emit('close')">{{ check?.blockers.length ? 'OK' : 'Cancel' }}</button>
        <button v-if="check && !check.blockers.length" class="btn primary" :disabled="!canMove" @click="move">
          <span v-if="runner.running.value" class="spin" />Move {{ check.folder }}
        </button>
      </template>
    </template>
  </Modal>
</template>

<style scoped>
.notes {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.notes li {
  align-items: flex-start;
}
.blockers {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.blockers li {
  align-items: flex-start;
}
.warn-icon {
  flex: none;
  margin-top: 2px;
  color: var(--warn);
}
.warn-text {
  color: var(--warn);
}
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
</style>
