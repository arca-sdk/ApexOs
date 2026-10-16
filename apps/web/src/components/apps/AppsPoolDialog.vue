<script setup lang="ts">
/**
 * Chooses the pool apps run from. Installed apps move along: TrueNAS copies them and starts the ones that
 * were running. Opened from a pool card (`pool` given) or from the Apps pages (the user picks the pool).
 */
import { computed, onMounted, ref, watch } from 'vue';
import type { AppsPoolPreview, Pool, StorageOverview, TaskStarted } from '@apexos/api-types';
import HealthBadge from '../HealthBadge.vue';
import Modal from '../Modal.vue';
import TaskProgress from '../storage/TaskProgress.vue';
import { useTaskRunner } from '../storage/taskRunner.ts';
import { api } from '../../lib/api.ts';
import { formatBytes } from '../../lib/format.ts';

const props = defineProps<{ pool?: string }>();
const emit = defineEmits<{ close: []; done: [] }>();

const pools = ref<Pool[] | null>(null);
const loadError = ref<string | null>(null);
const choice = ref<string | null>(props.pool ?? null);
const preview = ref<AppsPoolPreview | null>(null);
const previewError = ref<string | null>(null);
const eraseOk = ref(false);
const runner = useTaskRunner(() => emit('done'));

/** Pools apps could run from instead (not the one they use now). */
const candidates = computed(() => (pools.value ?? []).filter((p) => !p.isAppsPool));
function nameOf(pool: string | null | undefined): string {
  if (!pool) return '';
  return pools.value?.find((p) => p.name === pool)?.displayName ?? pool;
}
const target = computed(() => nameOf(choice.value));
const current = computed(() => nameOf(preview.value?.currentPool));

onMounted(async () => {
  try {
    pools.value = (await api.get<StorageOverview>('/storage')).pools;
    if (!choice.value) {
      // Suggest an SSD pool, else the one with the most free space.
      const usable = candidates.value.filter((p) => p.health !== 'offline');
      choice.value = (usable.find((p) => p.kind === 'performance') ?? [...usable].sort((a, b) => b.freeBytes - a.freeBytes)[0])?.name ?? null;
    }
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e);
  }
});

let previewSeq = 0;
watch(
  choice,
  async (pool) => {
    preview.value = null;
    previewError.value = null;
    eraseOk.value = false;
    if (!pool) return;
    const seq = ++previewSeq;
    try {
      const p = await api.get<AppsPoolPreview>(`/apps/pool?pool=${encodeURIComponent(pool)}`);
      if (seq === previewSeq) preview.value = p;
    } catch (e) {
      if (seq === previewSeq) previewError.value = e instanceof Error ? e.message : String(e);
    }
  },
  { immediate: true },
);

const moving = computed(() => preview.value?.moving ?? []);
/** "Jellyfin", "Jellyfin and Plex", "Jellyfin, Plex and Immich". */
const movingText = computed(() => {
  const list = moving.value;
  return list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list.at(-1)}` : (list[0] ?? '');
});
const remoteMoving = computed(() => moving.value.some((n) => /tailscale|cloudflare/i.test(n)));
const canSubmit = computed(() => {
  const p = preview.value;
  return Boolean(p && !p.problem && (!p.needsEraseConsent || eraseOk.value) && !runner.running.value);
});

function submit() {
  if (!canSubmit.value || !choice.value) return;
  void runner.start(api.put<TaskStarted>('/apps/pool', { pool: choice.value, eraseOldAppData: eraseOk.value }));
}
</script>

<template>
  <Modal :title="pool ? `Use ${target} for apps?` : 'Choose a pool for apps'" wide @close="emit('close')">
    <TaskProgress v-if="runner.task.value" :task="runner.task.value" />
    <p v-else-if="loadError" class="callout err">{{ loadError }}</p>
    <div v-else-if="!pools" class="row muted" role="status"><span class="spin" /> Loading your pools…</div>
    <div v-else class="stack" style="--gap: 14px">
      <fieldset v-if="!pool" class="field plain">
        <legend class="field-label">Pool</legend>
        <label v-for="p in candidates" :key="p.name" class="choice" :class="{ selected: choice === p.name, disabled: p.health === 'offline' }">
          <input v-model="choice" type="radio" name="apps-pool" :value="p.name" :disabled="p.health === 'offline'" />
          <span class="stack" style="--gap: 2px; flex: 1">
            <span class="row wrap" style="--gap: 8px">
              <strong>{{ p.displayName }}</strong>
              <HealthBadge v-if="p.health !== 'healthy'" :health="p.health" />
            </span>
            <span class="small muted">{{ formatBytes(p.freeBytes) }} free{{ p.kind === 'performance' ? ' · fast (SSD)' : p.kind === 'capacity' ? ' · large (hard drives)' : '' }}</span>
          </span>
        </label>
        <p v-if="!candidates.length" class="callout warn">
          There’s no other pool apps could use. <RouterLink to="/storage">Create a pool</RouterLink> first.
        </p>
        <span v-else class="hint">Apps are fastest on SSDs.</span>
      </fieldset>

      <div v-if="choice && !preview && !previewError" class="row muted" role="status"><span class="spin" /> Checking {{ target }}…</div>
      <p v-if="previewError" class="callout err">{{ previewError }}</p>
      <template v-if="preview">
        <p v-if="preview.problem" class="callout err">{{ preview.problem }}</p>
        <template v-else>
          <template v-if="moving.length">
            <p>
              {{ movingText }}
              {{ moving.length === 1 ? 'moves' : 'move' }} from {{ current }} to {{ target }},
              {{ moving.length === 1 ? 'with its settings and the data it keeps for itself' : 'with their settings and the data they keep for themselves' }}
              (about {{ formatBytes(preview.copyBytes) }}). Apps are unavailable while they move; the ones that are running start again afterwards.
            </p>
            <p class="small muted">
              Your folders, such as Media or Photos, stay where they are. The old copy of your apps stays on {{ current }} for a week in case something isn’t
              right, then ApexOs removes it.
            </p>
            <p v-if="remoteMoving" class="callout warn small">
              Remote access moves too. If you’re connected through it, you’ll lose the connection until the move is done.
            </p>
          </template>
          <p v-else-if="preview.currentPoolOffline" class="callout warn">
            Apps on {{ current }} can’t move while it’s offline. They stay there and come back if you choose {{ current }} again once it’s repaired.
            On {{ target }}, apps start from scratch.
          </p>
          <p v-else>Apps will keep their settings and data on {{ target }}.</p>

          <p v-if="preview.oldAppData && !preview.needsEraseConsent" class="small muted">
            {{ target }} still has app data from when apps last ran there. ApexOs uses it, so apps saved in it show up again.
          </p>
          <label v-if="preview.needsEraseConsent" class="option">
            <input v-model="eraseOk" type="checkbox" />
            <span class="stack" style="--gap: 2px">
              <strong>Erase the older app data on {{ target }}</strong>
              <span class="small muted">
                {{ target }} still holds app data from when apps last ran there. TrueNAS only moves apps to a pool without it, so that older copy is erased
                for good first. Your folders aren’t affected.
              </span>
            </span>
          </label>
        </template>
      </template>
      <p v-if="runner.error.value" class="callout err">{{ runner.error.value }}</p>
    </div>

    <template #footer>
      <button class="btn" @click="emit('close')">{{ runner.task.value ? 'Close' : 'Cancel' }}</button>
      <button v-if="!runner.task.value" class="btn primary" :disabled="!canSubmit" @click="submit">
        <span v-if="runner.running.value" class="spin" />{{ moving.length ? 'Move apps' : 'Use for apps' }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
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
.choice,
.option {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.choice {
  margin-bottom: 8px;
}
.choice input,
.option input {
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
.spin {
  width: 14px;
  height: 14px;
}
</style>
