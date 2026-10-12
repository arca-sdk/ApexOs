<script setup lang="ts">
import { Mountain } from 'lucide-vue-next';

defineProps<{ title: string; subtitle?: string; width?: string }>();
</script>

<template>
  <div class="frame">
    <div class="inner" :style="{ width: `min(${width ?? '440px'}, 100%)` }">
      <div class="row brand"><Mountain :size="26" style="color: var(--accent)" /> <strong>ApexOs</strong></div>
      <div class="card stack" style="--gap: 20px; padding: 28px">
        <div class="stack" style="--gap: 6px">
          <h1>{{ title }}</h1>
          <p v-if="subtitle" class="muted">{{ subtitle }}</p>
        </div>
        <slot />
      </div>
      <p class="small muted footer"><slot name="footer" /></p>
    </div>
  </div>
</template>

<style scoped>
.frame {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 32px 16px;
}
.inner {
  max-width: 100%;
}
.brand {
  justify-content: center;
  font-size: 1.3rem;
  margin-bottom: 20px;
  --gap: 10px;
}
.footer {
  text-align: center;
  margin-top: 16px;
}
</style>
