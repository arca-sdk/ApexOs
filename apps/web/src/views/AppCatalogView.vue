<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ArrowLeft, Search, Sparkles, X } from 'lucide-vue-next';
import type { CatalogApp, CatalogResponse } from '@apexos/api-types';
import { api } from '../lib/api.ts';
import { onServerChange } from '../lib/events.ts';
import PageState from '../components/PageState.vue';
import AppDetailDialog from '../components/apps/AppDetailDialog.vue';
import AppsPoolDialog from '../components/apps/AppsPoolDialog.vue';
import CatalogCard from '../components/apps/CatalogCard.vue';
import { categoryLabel, errorText } from '../components/apps/apps.ts';

const route = useRoute();
const router = useRouter();

const data = ref<CatalogResponse | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);

const one = (v: unknown) => (typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : '');
const search = ref(one(route.query.q));
const category = ref(one(route.query.category));
const choosingPool = ref(false);
const selected = ref<{ id: string; train?: string } | null>(route.query.app ? { id: one(route.query.app), train: one(route.query.train) || undefined } : null);

async function load(silent = false) {
  if (!silent) loading.value = true;
  try {
    // The whole catalog is fetched once and filtered here, so search is instant.
    data.value = await api.get<CatalogResponse>('/apps/catalog');
    error.value = null;
  } catch (e) {
    if (!silent || !data.value) error.value = errorText(e);
  } finally {
    loading.value = false;
  }
}
onMounted(() => load());
onServerChange(['apps'], () => load(true));

// Keep the address bar in step, so a search, filter or open app can be bookmarked or shared.
watch([search, category, selected], () => {
  const query: Record<string, string> = {};
  if (search.value.trim()) query.q = search.value.trim();
  if (category.value) query.category = category.value;
  if (selected.value) {
    query.app = selected.value.id;
    if (selected.value.train) query.train = selected.value.train;
  }
  void router.replace({ query });
});

function matches(app: CatalogApp, q: string): boolean {
  return `${app.title} ${app.id} ${app.description} ${app.categories.join(' ')} ${app.categories.map(categoryLabel).join(' ')}`.toLowerCase().includes(q);
}

const all = computed(() => data.value?.apps ?? []);
const curatedCount = computed(() => all.value.filter((a) => a.tier === 'curated').length);
const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  return all.value.filter(
    (a) => (!q || matches(a, q)) && (!category.value || (category.value === 'curated' ? a.tier === 'curated' : a.categories.includes(category.value))),
  );
});
/** With no search or filter, curated apps get their own section at the top. */
const sectioned = computed(() => !search.value.trim() && !category.value);
const curated = computed(() => filtered.value.filter((a) => a.tier === 'curated'));
const others = computed(() => filtered.value.filter((a) => a.tier !== 'curated'));

const chips = computed(() => [
  { id: '', label: 'All' },
  { id: 'curated', label: 'Curated' },
  ...(data.value?.categories ?? []).map((c) => ({ id: c, label: categoryLabel(c) })),
]);

function open(app: CatalogApp) {
  selected.value = { id: app.id, train: app.train };
}
function clearFilters() {
  search.value = '';
  category.value = '';
}
</script>

<template>
  <RouterLink to="/apps" class="back small"><ArrowLeft :size="15" /> My apps</RouterLink>
  <div class="page-header">
    <div>
      <h1>App catalog</h1>
      <p class="subtitle">Find something new for your server. Curated apps are set up for you in one click.</p>
    </div>
  </div>

  <PageState :loading="loading && !data" :error="error" @retry="load()">
    <div v-if="data && !data.appsPool" class="callout warn stack" style="--gap: 6px">
      <strong>Apps need a storage pool first</strong>
      <p>Apps keep their settings and data on a pool. Choose one of your pools, or create a new one on the Storage page.</p>
      <div class="row wrap" style="--gap: 8px">
        <button class="btn small primary" @click="choosingPool = true">Choose a pool</button>
        <RouterLink to="/storage" class="btn small">Go to Storage</RouterLink>
      </div>
    </div>

    <div v-else class="stack" style="--gap: 18px">
      <div class="filters stack" style="--gap: 12px">
        <div class="search">
          <Search :size="17" class="search-icon" aria-hidden="true" />
          <input
            v-model="search"
            type="text"
            inputmode="search"
            enterkeyhint="search"
            placeholder="Search apps, like “photos” or “movies”"
            aria-label="Search apps"
            autocomplete="off"
            @keydown.esc="search = ''"
          />
          <button v-if="search" class="btn ghost small clear" aria-label="Clear search" @click="search = ''"><X :size="15" /></button>
        </div>
        <div class="chips" role="group" aria-label="Category">
          <button
            v-for="c in chips"
            :key="c.id"
            type="button"
            class="chip"
            :class="{ curated: c.id === 'curated' }"
            :aria-pressed="category === c.id"
            @click="category = c.id"
          >
            <Sparkles v-if="c.id === 'curated'" :size="13" aria-hidden="true" />
            {{ c.label }}
            <span v-if="c.id === 'curated'" class="chip-count">{{ curatedCount }}</span>
          </button>
        </div>
      </div>

      <p class="sr-status" aria-live="polite">{{ filtered.length }} {{ filtered.length === 1 ? 'app' : 'apps' }} shown</p>

      <template v-if="!filtered.length">
        <div class="card empty">
          <strong>No apps match{{ search.trim() ? ` “${search.trim()}”` : '' }}</strong>
          <p class="muted small">Try a different word, or look through all categories.</p>
          <button class="btn small" @click="clearFilters">Show all apps</button>
        </div>
      </template>

      <template v-else-if="sectioned">
        <section v-if="curated.length" class="stack" style="--gap: 12px" aria-labelledby="sec-curated">
          <div>
            <h2 id="sec-curated">Ready in one click</h2>
            <p class="small muted">Curated by ApexOs: folders, permissions and settings are taken care of, and the app is ready when it opens.</p>
          </div>
          <div class="grid" style="--min: 250px">
            <CatalogCard v-for="app in curated" :key="`${app.train}/${app.id}`" :app="app" @open="open(app)" />
          </div>
        </section>
        <section v-if="others.length" class="stack" style="--gap: 12px" aria-labelledby="sec-catalog">
          <div>
            <h2 id="sec-catalog">More from the TrueNAS catalog</h2>
            <p class="small muted">These install with the catalog's standard settings. Some may need a little setup inside the app afterwards.</p>
          </div>
          <div class="grid" style="--min: 250px">
            <CatalogCard v-for="app in others" :key="`${app.train}/${app.id}`" :app="app" @open="open(app)" />
          </div>
        </section>
      </template>

      <div v-else class="grid" style="--min: 250px">
        <CatalogCard v-for="app in filtered" :key="`${app.train}/${app.id}`" :app="app" @open="open(app)" />
      </div>
    </div>
  </PageState>

  <AppsPoolDialog v-if="choosingPool" @close="choosingPool = false" @done="(choosingPool = false), load()" />
  <AppDetailDialog v-if="selected" :key="`${selected.train}/${selected.id}`" :app-id="selected.id" :train="selected.train" @close="selected = null" />
</template>

<style scoped>
.back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
  color: var(--text-muted);
  font-weight: 550;
}
.search {
  position: relative;
  max-width: 520px;
}
.search input {
  padding-left: 38px;
  padding-right: 40px;
}
.search-icon {
  position: absolute;
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-muted);
}
.clear {
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
  padding: 4px 6px;
}
.chips {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  /* Scroll sideways instead of widening the page on narrow screens. */
  contain: inline-size;
  padding-bottom: 4px;
  scrollbar-width: thin;
}
.chip {
  appearance: none;
  font: inherit;
  font-size: 0.88rem;
  font-weight: 550;
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text-muted);
  cursor: pointer;
}
.chip:hover {
  color: var(--text);
  background: var(--surface-2);
}
.chip[aria-pressed='true'] {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent-strong);
}
.chip:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.chip-count {
  font-size: 0.75rem;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--surface-2);
}
.chip[aria-pressed='true'] .chip-count {
  background: var(--surface);
}
.sr-status {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  text-align: center;
  padding: 36px 20px;
}
</style>
