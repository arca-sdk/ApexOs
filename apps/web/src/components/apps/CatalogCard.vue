<script setup lang="ts">
import { CircleCheck } from 'lucide-vue-next';
import type { CatalogApp } from '@hearth/api-types';
import AppIcon from './AppIcon.vue';
import TierBadge from './TierBadge.vue';
import { categoryLabel } from './apps.ts';

defineProps<{ app: CatalogApp }>();
const emit = defineEmits<{ open: [] }>();
</script>

<template>
  <button class="card catalog-card" type="button" :aria-label="`${app.title}: view details${app.installed ? ' (installed)' : ''}`" @click="emit('open')">
    <div class="head">
      <AppIcon :src="app.icon" :title="app.title" :size="44" />
      <div class="ident">
        <strong class="title" :title="app.title">{{ app.title }}</strong>
        <div class="row wrap" style="--gap: 6px">
          <TierBadge :tier="app.tier" />
          <span v-if="app.installed" class="badge ok"><CircleCheck :size="12" aria-hidden="true" /> Installed</span>
        </div>
      </div>
    </div>
    <p class="desc small" :title="app.description">{{ app.description || 'No description provided.' }}</p>
    <div class="foot small muted">
      <span v-if="app.categories.length">{{ app.categories.map(categoryLabel).join(' · ') }}</span>
      <span class="spacer" />
      <span v-if="app.appVersion" class="mono" :title="`Version ${app.appVersion}`">{{ /^\d/.test(app.appVersion) ? `v${app.appVersion}` : app.appVersion }}</span>
    </div>
  </button>
</template>

<style scoped>
.catalog-card {
  appearance: none;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  min-width: 0;
  transition:
    border-color 0.12s,
    transform 0.12s;
}
.catalog-card:hover {
  border-color: var(--accent);
}
.catalog-card:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.head {
  display: flex;
  gap: 12px;
  align-items: center;
  min-width: 0;
}
.ident {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.desc {
  color: var(--text-muted);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  flex: 1;
}
.foot {
  display: flex;
  gap: 8px;
  align-items: center;
  min-width: 0;
}
.foot > span:first-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.foot .mono {
  flex: none;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
