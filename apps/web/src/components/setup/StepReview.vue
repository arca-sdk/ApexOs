<script setup lang="ts">
/** Step 5: "Almost done" review cards, each with an Edit link back to its step. */
import { computed } from 'vue';
import { AppWindow, Clock, Database, Server, Trash2, Users } from 'lucide-vue-next';
import HealthBadge from '../HealthBadge.vue';
import { layoutTitle } from '../storage/drives.ts';
import { formatBytes, toleranceText } from '../../lib/format.ts';
import { useWizard, type ScreenId } from './wizard.ts';

const emit = defineEmits<{ edit: [screen: ScreenId] }>();
const wizard = useWizard();
const { state } = wizard;

const review = computed(() => state.review);
const storageScreen = computed<ScreenId>(() => (state.mode === 'recommended' || state.mode === 'custom' ? 'storage-plan' : 'storage-mode'));
const hasExistingStep = computed(() => wizard.screens.value.includes('existing'));

const appsPoolLabel = computed(() => {
  const name = review.value?.appsPool;
  if (!name) return null;
  return wizard.keptPools.value.find((p) => p.name === name)?.displayName ?? name;
});
const users = computed(() => state.info?.serverUsers ?? []);
const problems = computed(() => [
  ...(review.value?.problems ?? []),
  ...wizard.nameClashes.value.map((n) => `A pool named ${n} stays on this server, so a new pool can’t use that name. Rename the new pool.`),
]);
</script>

<template>
  <div v-if="state.reviewLoading && !review" class="card row muted" role="status"><span class="spin" /> Checking your plan…</div>
  <div v-else-if="state.reviewError" class="callout err stack" style="--gap: 8px" role="alert">
    <span>ApexOs couldn’t check your plan: {{ state.reviewError }}</span>
    <div><button class="btn small" @click="wizard.loadReview()">Try again</button></div>
  </div>

  <div v-else-if="review" class="stack" style="--gap: 14px" :aria-busy="state.reviewLoading">
    <div v-if="problems.length" class="callout err stack" style="--gap: 6px" role="alert">
      <strong>Fix these before you finish</strong>
      <ul class="problems">
        <li v-for="p in problems" :key="p">{{ p }}</li>
      </ul>
    </div>

    <section class="card review-card">
      <div class="row head">
        <Server :size="18" aria-hidden="true" />
        <h3>Server</h3>
        <span class="spacer" />
        <button class="btn ghost small" aria-label="Edit server name and time zone" @click="emit('edit', 'basics')">Edit</button>
      </div>
      <dl class="facts">
        <div>
          <dt class="muted">Name</dt>
          <dd>
            <strong>{{ state.serverName.trim() }}</strong>
          </dd>
        </div>
        <div>
          <dt class="muted"><Clock :size="14" aria-hidden="true" /> Time zone</dt>
          <dd>{{ state.timezone.replace(/_/g, ' ') }}</dd>
        </div>
      </dl>
    </section>

    <section class="card review-card">
      <div class="row head">
        <Database :size="18" aria-hidden="true" />
        <h3>Storage pools</h3>
        <span class="spacer" />
        <button class="btn ghost small" aria-label="Edit storage pools" @click="emit('edit', storageScreen)">Edit</button>
      </div>
      <p v-if="!review.newPools.length && !wizard.keptPools.value.length && !wizard.importing.value.length" class="small muted">No pools.</p>
      <ul class="pools">
        <li v-for="p in review.newPools" :key="`new-${p.name}`">
          <div class="row wrap" style="--gap: 8px">
            <strong>{{ p.name }}</strong>
            <span class="badge accent">New</span>
          </div>
          <span class="small muted">
            about {{ formatBytes(p.usableBytes) }} · {{ layoutTitle(p.layout, p.drives.length)
            }}<template v-if="p.drives.length > 1"> on {{ p.drives.length }} drives</template> · {{ toleranceText(p.faultTolerance) }}
          </span>
        </li>
        <li v-for="p in wizard.importing.value" :key="`imp-${p.guid}`">
          <div class="row wrap" style="--gap: 8px">
            <strong>{{ p.name }}</strong>
            <span class="badge info">Imported</span>
          </div>
          <span class="small muted">Brought in with everything on it{{ p.hostname ? `, from ${p.hostname}` : '' }}.</span>
        </li>
        <li v-for="p in wizard.keptPools.value" :key="`kept-${p.name}`">
          <div class="row wrap" style="--gap: 8px">
            <strong>{{ p.displayName }}</strong>
            <span class="badge">Kept</span>
            <HealthBadge v-if="p.health !== 'healthy'" :health="p.health" />
          </div>
          <span class="small muted">
            {{ formatBytes(p.usedBytes) }} used of {{ formatBytes(p.sizeBytes) }} · {{ toleranceText(p.faultTolerance) }}
            <template v-if="p.folders.length"> · {{ p.folders.length }} {{ p.folders.length === 1 ? 'folder' : 'folders' }}</template>
            <template v-if="p.apps.length"> · {{ p.apps.length }} {{ p.apps.length === 1 ? 'app' : 'apps' }}</template>
          </span>
          <span v-if="p.health !== 'healthy'" class="small warn-text">This pool isn’t healthy. Check it on the Storage page after setup.</span>
        </li>
      </ul>
    </section>

    <section v-if="review.erasePools.length" class="card review-card erase">
      <div class="row head">
        <Trash2 :size="18" aria-hidden="true" />
        <h3>Will be erased</h3>
        <span class="spacer" />
        <button v-if="hasExistingStep" class="btn ghost small" aria-label="Edit which pools you keep" @click="emit('edit', 'existing')">Edit</button>
      </div>
      <p class="small">
        New pools reuse drives from {{ review.erasePools.length === 1 ? 'this pool' : 'these pools' }}, so
        {{ review.erasePools.length === 1 ? 'it is' : 'they are' }} erased completely: every folder, file and app on
        {{ review.erasePools.length === 1 ? 'it' : 'them' }}. There is no undo.
      </p>
      <ul class="names">
        <li v-for="n in review.erasePools" :key="n"><strong>{{ n }}</strong></li>
      </ul>
    </section>

    <section v-if="review.untouchedPools.length" class="card review-card">
      <div class="row head">
        <Database :size="18" aria-hidden="true" />
        <h3>Left as they are</h3>
        <span class="spacer" />
        <button v-if="hasExistingStep" class="btn ghost small" aria-label="Edit which pools you keep" @click="emit('edit', 'existing')">Edit</button>
      </div>
      <p class="small muted">You’re not keeping these, but none of their drives are reused, so they stay on their drives untouched.</p>
      <ul class="names">
        <li v-for="n in review.untouchedPools" :key="n">{{ n }}</li>
      </ul>
    </section>

    <section class="card review-card">
      <div class="row head">
        <AppWindow :size="18" aria-hidden="true" />
        <h3>Apps</h3>
      </div>
      <p v-if="appsPoolLabel" class="small">Apps will run from <strong>{{ appsPoolLabel }}</strong>.</p>
      <p v-else class="small muted">There’s no pool for apps yet.</p>
    </section>

    <section v-if="users.length" class="card flat review-card">
      <div class="row head">
        <Users :size="18" aria-hidden="true" />
        <h3>Also staying</h3>
      </div>
      <p class="small muted">{{ users.length }} {{ users.length === 1 ? 'user stays' : 'users stay' }} on this server: {{ users.join(', ') }}.</p>
    </section>
  </div>
</template>

<style scoped>
.review-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 18px;
}
.head {
  --gap: 10px;
}
.head :deep(svg) {
  color: var(--text-muted);
  flex: none;
}
.erase {
  border-color: var(--err);
  background: var(--err-soft);
}
.erase .head :deep(svg) {
  color: var(--err);
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
.facts dt {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.facts dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.pools {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.pools li {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 0;
  border-top: 1px solid var(--border);
}
.pools li:first-child {
  border-top: 0;
  padding-top: 0;
}
.names,
.problems {
  margin: 0;
  padding-left: 20px;
}
.warn-text {
  color: var(--warn);
}
</style>
