<script setup lang="ts">
/** Display preferences stored in this browser. */
import { ref, watch } from 'vue';
import { preferences } from '../../lib/format.ts';

const unit = ref<'C' | 'F'>(preferences.temperatureUnit);
const saved = ref(false);
watch(unit, (u) => {
  preferences.temperatureUnit = u;
  saved.value = true;
});

const options = [
  { value: 'C' as const, label: 'Celsius', example: '40 °C' },
  { value: 'F' as const, label: 'Fahrenheit', example: '104 °F' },
];
</script>

<template>
  <section class="card stack" aria-labelledby="ps-h">
    <h2 id="ps-h">Preferences</h2>
    <p class="muted small">These are saved in this browser only.</p>
    <fieldset class="plain stack" style="--gap: 8px">
      <legend class="field-label">Temperature unit</legend>
      <p class="small muted">Used for drive and processor temperatures.</p>
      <div class="row wrap" style="--gap: 10px">
        <label v-for="o in options" :key="o.value" class="choice" :class="{ selected: unit === o.value }">
          <input v-model="unit" type="radio" name="ps-unit" :value="o.value" />
          <span>{{ o.label }} <span class="muted small">({{ o.example }})</span></span>
        </label>
      </div>
      <p v-if="saved" class="small" role="status" style="color: var(--ok)">Saved. Temperatures now show in {{ unit === 'C' ? 'Celsius' : 'Fahrenheit' }}.</p>
    </fieldset>
  </section>
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
}
.choice {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.choice.selected {
  border-color: var(--accent);
  background: var(--accent-soft);
}
</style>
