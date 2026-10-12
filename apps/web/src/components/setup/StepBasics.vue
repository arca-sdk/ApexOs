<script setup lang="ts">
/** Step 1: server name and time zone. */
import { computed, ref } from 'vue';
import TimezonePicker from './TimezonePicker.vue';
import { serverNameProblem, useWizard } from './wizard.ts';

const { state } = useWizard();
const touched = ref(false);
const problem = computed(() => serverNameProblem(state.serverName));
const showProblem = computed(() => problem.value && (touched.value || state.serverName.length > 0));

const browserZone = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return null;
  }
})();
const offerBrowserZone = computed(
  () => browserZone && browserZone !== state.timezone && (state.info?.timezones.includes(browserZone) ?? false),
);
const detected = state.info?.timezone ?? null;
</script>

<template>
  <div class="card stack" style="--gap: 22px">
    <div class="field">
      <label for="server-name">Server name</label>
      <input
        id="server-name"
        v-model="state.serverName"
        type="text"
        maxlength="15"
        autocomplete="off"
        spellcheck="false"
        aria-describedby="server-name-hint"
        :aria-invalid="Boolean(showProblem)"
        @blur="touched = true"
      />
      <span v-if="showProblem" class="error-text" role="alert">{{ problem }}</span>
      <span id="server-name-hint" class="hint">
        2–15 letters, numbers or dashes, starting with a letter. Other computers on your network see the server under this name, for example
        <span class="mono">\\{{ state.serverName.trim() || 'homeserver' }}</span>.
      </span>
    </div>

    <div class="field">
      <label for="timezone">Time zone</label>
      <TimezonePicker id="timezone" v-model="state.timezone" :choices="state.info?.timezones ?? []" describedby="timezone-hint" />
      <span id="timezone-hint" class="hint">
        Used for scheduled jobs like the weekly pool check, and for the times shown in notifications.
        <template v-if="detected">The server is currently set to {{ detected.replace(/_/g, ' ') }}.</template>
      </span>
      <div v-if="offerBrowserZone">
        <button type="button" class="btn small" @click="state.timezone = browserZone!">Use this computer’s time zone ({{ browserZone!.replace(/_/g, ' ') }})</button>
      </div>
    </div>
  </div>
</template>
