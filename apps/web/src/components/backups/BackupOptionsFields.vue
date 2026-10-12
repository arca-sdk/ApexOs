<script setup lang="ts">
/** Schedule, retention and upload speed of a backup (used when creating and editing backups). */
import { computed, useId } from 'vue';
import type { BackupFrequency, BackupOptions } from '@apexos/api-types';
import { KEEP_CHOICES, WEEKDAYS } from './backups.ts';

const props = defineProps<{ timezone: string; errors?: Record<string, string> }>();
const model = defineModel<BackupOptions>({ required: true });
const id = useId();

const frequency = computed({
  get: () => model.value.schedule.frequency,
  set: (frequency: BackupFrequency) => {
    const keepDays = frequency === 'weekly' && model.value.keepDays < 7 ? 14 : model.value.keepDays;
    model.value = { ...model.value, keepDays, schedule: { ...model.value.schedule, frequency } };
  },
});
const time = computed({
  get: () => model.value.schedule.time,
  set: (time: string) => (model.value = { ...model.value, schedule: { ...model.value.schedule, time: time || '00:00' } }),
});
const minute = computed({
  get: () => model.value.schedule.time.split(':')[1] ?? '00',
  set: (m: string) => (model.value = { ...model.value, schedule: { ...model.value.schedule, time: `${model.value.schedule.time.split(':')[0] ?? '00'}:${m}` } }),
});
const weekday = computed({
  get: () => model.value.schedule.weekday,
  set: (weekday: number) => (model.value = { ...model.value, schedule: { ...model.value.schedule, weekday: Number(weekday) } }),
});
const keepChoices = computed(() => {
  const list = KEEP_CHOICES.filter((c) => frequency.value !== 'weekly' || c.days >= 7);
  return list.some((c) => c.days === model.value.keepDays) ? list : [...list, { days: model.value.keepDays, label: `${model.value.keepDays} days` }].sort((x, y) => x.days - y.days);
});
const keepDays = computed({
  get: () => model.value.keepDays,
  set: (days: number) => (model.value = { ...model.value, keepDays: Number(days) }),
});
const limited = computed({
  get: () => model.value.speedLimitMbps !== null,
  set: (on: boolean) => (model.value = { ...model.value, speedLimitMbps: on ? (model.value.speedLimitMbps ?? 50) : null }),
});
const speed = computed({
  get: () => model.value.speedLimitMbps ?? 50,
  set: (v: number) => (model.value = { ...model.value, speedLimitMbps: Number.isFinite(v) && v > 0 ? Math.round(v) : 1 }),
});
const restorePoints = computed(() => {
  const per = frequency.value === 'hourly' ? 24 : frequency.value === 'daily' ? 1 : 1 / 7;
  return Math.max(1, Math.floor(keepDays.value * per));
});
</script>

<template>
  <fieldset class="stack options" style="--gap: 14px">
    <legend class="field-label">When to back up</legend>
    <div class="row wrap" style="--gap: 12px; align-items: flex-end">
      <div class="field grow">
        <label :for="`${id}-freq`">How often</label>
        <select :id="`${id}-freq`" v-model="frequency">
          <option value="hourly">Every hour</option>
          <option value="daily">Every day</option>
          <option value="weekly">Every week</option>
        </select>
      </div>
      <div v-if="frequency === 'weekly'" class="field grow">
        <label :for="`${id}-day`">Day</label>
        <select :id="`${id}-day`" v-model.number="weekday">
          <option v-for="(d, i) in WEEKDAYS" :key="d" :value="i">{{ d }}</option>
        </select>
      </div>
      <div v-if="frequency === 'hourly'" class="field grow">
        <label :for="`${id}-min`">Minutes past the hour</label>
        <select :id="`${id}-min`" v-model="minute">
          <option v-for="m in ['00', '15', '30', '45']" :key="m" :value="m">:{{ m }}</option>
        </select>
      </div>
      <div v-else class="field grow">
        <label :for="`${id}-time`">Time</label>
        <input :id="`${id}-time`" v-model="time" type="time" required :aria-invalid="!!props.errors?.time || undefined" />
      </div>
    </div>
    <p class="small muted">
      Times are in the server’s time zone ({{ timezone }}). A quiet time, such as the night, is best: the first backup copies everything and can take hours.
    </p>
    <span v-if="props.errors?.time" class="error-text small">{{ props.errors.time }}</span>

    <div class="field">
      <label :for="`${id}-keep`">Keep restore points for</label>
      <select :id="`${id}-keep`" v-model.number="keepDays" :aria-describedby="`${id}-keep-hint`">
        <option v-for="c in keepChoices" :key="c.days" :value="c.days">{{ c.label }}</option>
      </select>
      <span :id="`${id}-keep-hint`" class="hint">
        Up to {{ restorePoints }} restore {{ restorePoints === 1 ? 'point' : 'points' }} you can go back to. Older ones are deleted on both servers. Files you delete stay in the
        backup until the last restore point that has them is gone.
      </span>
      <span v-if="props.errors?.keepDays" class="error-text">{{ props.errors.keepDays }}</span>
    </div>

    <div class="stack" style="--gap: 8px">
      <span class="field-label">Upload speed</span>
      <label class="row" style="--gap: 8px">
        <input v-model="limited" type="radio" :name="`${id}-speed`" :value="false" />
        <span>Full speed</span>
      </label>
      <label class="row wrap" style="--gap: 8px">
        <input v-model="limited" type="radio" :name="`${id}-speed`" :value="true" />
        <span>Limit to</span>
        <input
          v-model.number="speed"
          class="speed"
          type="number"
          min="1"
          max="100000"
          step="1"
          :disabled="!limited"
          :aria-label="'Speed limit in megabits per second'"
          :aria-invalid="!!props.errors?.speedLimitMbps || undefined"
        />
        <span>Mbit/s</span>
      </label>
      <span class="hint small muted">A limit leaves room for other traffic, for example when the other server is reached over the internet through your VPN.</span>
      <span v-if="props.errors?.speedLimitMbps" class="error-text small">{{ props.errors.speedLimitMbps }}</span>
    </div>
  </fieldset>
</template>

<style scoped>
.options {
  border: 0;
  margin: 0;
  padding: 0;
  min-width: 0;
}
.options legend {
  padding: 0;
  margin-bottom: 4px;
}
.grow {
  flex: 1 1 140px;
  min-width: 0;
}
.speed {
  width: 110px;
}
</style>
