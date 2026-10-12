<script setup lang="ts">
import { computed } from 'vue';
import { Sparkles } from 'lucide-vue-next';
import type { SupportTier } from '@hearth/api-types';

const props = defineProps<{ tier: SupportTier | 'custom' }>();
const view = computed(
  () =>
    ({
      curated: { cls: 'accent', text: 'Curated', hint: 'Set up for you by Hearth: folders, permissions and settings are handled in one click.' },
      catalog: { cls: '', text: 'TrueNAS catalog', hint: 'Installed straight from the TrueNAS catalog with its default settings.' },
      custom: { cls: '', text: 'Custom', hint: 'A custom app added in TrueNAS.' },
    })[props.tier],
);
</script>

<template>
  <span class="badge" :class="view.cls" :title="view.hint">
    <Sparkles v-if="tier === 'curated'" :size="12" aria-hidden="true" />
    {{ view.text }}
  </span>
</template>
