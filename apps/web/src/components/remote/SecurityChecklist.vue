<script setup lang="ts">
/** Security checklist for remote access: two-factor sign-in, password strength, secure cookies. */
import { CircleAlert, CircleCheck, CircleX } from 'lucide-vue-next';
import type { SecurityCheckItem } from '@apexos/api-types';

defineProps<{ items: SecurityCheckItem[] }>();

const fixLink: Partial<Record<SecurityCheckItem['id'], { to: string; label: string }>> = {
  'two-factor': { to: '/settings?section=account', label: 'Turn on two-factor sign-in' },
  password: { to: '/settings?section=account', label: 'Change password' },
};
</script>

<template>
  <section class="card stack" aria-labelledby="sc-h" style="--gap: 14px">
    <h2 id="sc-h">Security checklist</h2>
    <p class="small muted">Before you reach your server from outside your home, make sure signing in is hard for anyone but you.</p>
    <ul class="checklist">
      <li v-for="item in items" :key="item.id">
        <CircleCheck v-if="item.ok === true" :size="20" class="icon ok" aria-hidden="true" />
        <CircleX v-else-if="item.ok === false" :size="20" class="icon err" aria-hidden="true" />
        <CircleAlert v-else :size="20" class="icon unknown" aria-hidden="true" />
        <div class="stack" style="--gap: 2px; min-width: 0">
          <strong>
            {{ item.title }}
            <span class="sr-only">: {{ item.ok === true ? 'done' : item.ok === false ? 'needs attention' : 'check this' }}</span>
          </strong>
          <span class="small muted detail">{{ item.detail }}</span>
          <RouterLink v-if="item.ok !== true && fixLink[item.id]" :to="fixLink[item.id]!.to" class="small">{{ fixLink[item.id]!.label }}</RouterLink>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.checklist {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.checklist li {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}
.icon {
  flex: none;
  margin-top: 1px;
}
.icon.ok {
  color: var(--ok);
}
.icon.err {
  color: var(--err);
}
.icon.unknown {
  color: var(--warn);
}
.detail {
  overflow-wrap: anywhere;
}
</style>
