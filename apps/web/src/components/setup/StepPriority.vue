<script setup lang="ts">
/** Step 4a (Recommended): what matters most, space or protection. */
import { computed, onMounted } from 'vue';
import { Maximize2, Scale, ShieldCheck } from 'lucide-vue-next';
import type { PlanPriority } from '@hearth/api-types';
import ChoiceCard from './ChoiceCard.vue';
import { useWizard } from './wizard.ts';

const wizard = useWizard();
const { state } = wizard;

onMounted(() => {
  state.priority = wizard.effectivePriority();
});

const n = computed(() => wizard.candidates.value.length);
const suggested = computed<PlanPriority>(() => (n.value >= 3 ? 'balanced' : 'protection'));
const OPTIONS = computed<Record<PlanPriority, { title: string; description: string; icon: typeof Scale }>>(() => ({
  space: {
    title: 'Most space',
    icon: Maximize2,
    description:
      n.value === 2
        ? 'Combine both drives into one big pool. If either drive fails, everything on the pool is lost.'
        : 'Keep as much space as possible. Groups of three or more drives can still lose one drive; pairs get no protection.',
  },
  balanced: {
    title: 'Balanced',
    icon: Scale,
    description: 'Good protection without giving up too much space. Larger groups of drives get extra protection.',
  },
  protection: {
    title: 'Most protection',
    icon: ShieldCheck,
    description:
      n.value === 2
        ? 'Both drives hold the same data, so either one can fail without losing anything. You get the space of one drive.'
        : 'Survive more drive failures at once, at the cost of some space.',
  },
}));
</script>

<template>
  <div class="stack" role="radiogroup" aria-label="What matters most" style="--gap: 10px">
    <ChoiceCard
      v-for="p in wizard.priorityChoices()"
      :key="p"
      v-model="state.priority"
      name="priority"
      :value="p"
      :icon="OPTIONS[p].icon"
      :title="OPTIONS[p].title"
      :description="OPTIONS[p].description"
      :badge="p === suggested ? 'Suggested' : undefined"
    />
  </div>
</template>
