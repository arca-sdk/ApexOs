<script setup lang="ts">
/** "Working on it!" checklist for the setup task, then "Your server is ready" (or what went wrong). */
import { computed, nextTick, ref, watch } from 'vue';
import { Circle, CircleCheck, CircleMinus, CircleX, PartyPopper } from 'lucide-vue-next';
import type { Task } from '@apexos/api-types';

const props = defineProps<{ task: Task; leaving?: boolean }>();
const emit = defineEmits<{ dashboard: []; replan: [] }>();

const heading = ref<HTMLElement | null>(null);
const done = computed(() => props.task.status === 'success');
const failed = computed(() => props.task.status === 'failed');
const nothingChanged = computed(() => {
  const first = props.task.steps[0];
  return failed.value && first?.status === 'failed';
});

watch(
  () => props.task.status,
  async () => {
    await nextTick();
    heading.value?.focus();
  },
);
</script>

<template>
  <div class="progress-view">
    <div class="card stack" style="--gap: 20px">
      <template v-if="done">
        <div class="ready">
          <PartyPopper :size="40" aria-hidden="true" class="party" />
          <h1 ref="heading" tabindex="-1">Your server is ready</h1>
          <p class="muted">Your pools are set up and the server is configured. Next, create folders to share, add people, and install apps.</p>
          <button class="btn primary big" :disabled="leaving" @click="emit('dashboard')"><span v-if="leaving" class="spin" />Go to the dashboard</button>
        </div>
      </template>
      <template v-else>
        <div class="stack" style="--gap: 6px">
          <h1 ref="heading" tabindex="-1">{{ failed ? 'Setup didn’t finish' : 'Working on it!' }}</h1>
          <p class="muted">
            {{
              failed
                ? 'Something went wrong along the way.'
                : 'ApexOs is setting up your server. This usually takes a minute or two. Please keep this page open.'
            }}
          </p>
        </div>
        <div v-if="!failed" class="meter" role="progressbar" :aria-valuenow="task.progress" aria-valuemin="0" aria-valuemax="100" aria-label="Setup progress">
          <span :style="{ width: `${task.progress}%` }" />
        </div>
      </template>

      <ol class="steps" aria-label="Setup steps">
        <li v-for="s in task.steps" :key="s.name" :class="s.status">
          <span class="icon" aria-hidden="true">
            <CircleCheck v-if="s.status === 'success'" :size="20" />
            <CircleX v-else-if="s.status === 'failed'" :size="20" />
            <CircleMinus v-else-if="s.status === 'skipped'" :size="20" />
            <span v-else-if="s.status === 'running'" class="spin" />
            <Circle v-else :size="20" />
          </span>
          <div class="text">
            <span class="name">{{ s.name }}</span>
            <span class="sr-only">({{ { success: 'done', failed: 'failed', skipped: 'not needed', running: 'in progress', pending: 'waiting' }[s.status] }})</span>
            <span v-if="s.status === 'skipped'" class="small muted">Not needed</span>
            <span v-else-if="s.status === 'running' && s.message" class="small muted">{{ s.message }}</span>
            <span v-else-if="s.status === 'failed' && s.message" class="small err-text">{{ s.message }}</span>
          </div>
        </li>
      </ol>

      <div v-if="failed" class="stack" style="--gap: 12px">
        <p class="callout err" role="alert">{{ task.error ?? 'Setup failed.' }}</p>
        <p class="small muted">
          <template v-if="nothingChanged">Nothing on your drives was changed. Go back, look at the plan again and try once more.</template>
          <template v-else>Some steps already ran. Go back to see how your drives look now, adjust the plan and try again.</template>
        </p>
        <div><button class="btn primary" @click="emit('replan')">Back to the plan</button></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.progress-view {
  max-width: 620px;
  margin: 0 auto;
  padding: 40px 16px 64px;
}
h1 {
  outline: none;
}
.ready {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 12px;
  padding: 12px 0 4px;
}
.party {
  color: var(--accent);
}
.big {
  padding: 10px 22px;
  margin-top: 6px;
}
.steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.steps li {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.icon {
  width: 20px;
  height: 20px;
  flex: none;
  display: grid;
  place-items: center;
  color: var(--text-muted);
  margin-top: 1px;
}
.icon .spin {
  width: 16px;
  height: 16px;
  color: var(--accent);
}
.success .icon {
  color: var(--ok);
}
.failed .icon {
  color: var(--err);
}
.text {
  display: flex;
  flex-direction: column;
}
.pending .name,
.skipped .name {
  color: var(--text-muted);
}
.running .name {
  font-weight: 600;
}
.err-text {
  color: var(--err);
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
</style>
