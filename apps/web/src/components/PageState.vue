<script setup lang="ts">
/** Standard loading / error placeholder with "Try again". Renders the default slot when ready. */
defineProps<{ loading: boolean; error?: string | null }>();
const emit = defineEmits<{ retry: [] }>();
</script>

<template>
  <div v-if="error" class="card stack state" style="--gap: 12px">
    <strong>This section isn't available right now</strong>
    <p class="muted small">{{ error }}</p>
    <div><button class="btn" @click="emit('retry')">Try again</button></div>
  </div>
  <div v-else-if="loading" class="row muted state-loading"><span class="spin" /> Loading…</div>
  <slot v-else />
</template>

<style scoped>
.state {
  align-items: flex-start;
}
.state-loading {
  padding: 24px 0;
}
</style>
