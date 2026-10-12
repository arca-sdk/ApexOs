<script setup lang="ts">
/** What a curated app needs from the server, with a pass/fail mark for each item. */
import { CircleCheck, CircleX } from 'lucide-vue-next';
import type { AppRequirementsInfo } from '@hearth/api-types';

defineProps<{ req: AppRequirementsInfo }>();
</script>

<template>
  <section class="req stack" style="--gap: 12px" aria-labelledby="req-heading">
    <div class="row" style="--gap: 8px">
      <h3 id="req-heading">Requirements</h3>
      <span class="badge" :class="req.ok ? 'ok' : 'err'">{{ req.ok ? 'All met' : 'Not met' }}</span>
    </div>

    <div v-if="req.locations.length" class="group">
      <div class="label small muted">Folders it uses</div>
      <ul>
        <li v-for="l in req.locations" :key="l.id" :class="{ bad: !l.met }">
          <CircleCheck v-if="l.met" :size="16" class="ok-icon" aria-label="Ready" />
          <CircleX v-else :size="16" class="bad-icon" aria-label="Missing" />
          <span class="name">{{ l.name }}</span>
          <span v-if="l.path" class="mono small muted path">{{ l.path }}</span>
          <span v-else class="small">Not set up yet</span>
        </li>
      </ul>
      <p v-if="req.locations.some((l) => !l.met)" class="small muted">
        Hearth needs a storage pool to create these folders on. Create one on the <RouterLink to="/storage">Storage</RouterLink> page.
      </p>
      <p v-else class="small muted">Folders that don't exist yet are created during install.</p>
    </div>

    <div v-if="req.specs.length" class="group">
      <div class="label small muted">Hardware</div>
      <ul class="inline">
        <li v-for="s in req.specs" :key="s.label" :class="{ bad: !s.met }">
          <CircleCheck v-if="s.met" :size="16" class="ok-icon" aria-label="Met" />
          <CircleX v-else :size="16" class="bad-icon" aria-label="Not met" />
          <span>{{ s.label }}</span>
        </li>
      </ul>
    </div>

    <div v-if="req.ports.length" class="group">
      <div class="label small muted">Network ports</div>
      <ul class="inline">
        <li v-for="p in req.ports" :key="p" :class="{ bad: req.portConflicts.includes(p) }">
          <CircleX v-if="req.portConflicts.includes(p)" :size="16" class="bad-icon" aria-label="In use" />
          <CircleCheck v-else :size="16" class="ok-icon" aria-label="Free" />
          <span class="mono">{{ p }}</span>
        </li>
      </ul>
      <p v-if="req.portConflicts.length" class="callout err small">
        {{ req.portConflicts.length === 1 ? `Port ${req.portConflicts[0]} is` : `Ports ${req.portConflicts.join(', ')} are` }}
        already used by another app. Stop or uninstall that app first, then try again.
      </p>
    </div>
  </section>
</template>

<style scoped>
.req {
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
}
.group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.label {
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-size: 0.75rem;
}
ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
ul.inline {
  flex-direction: row;
  flex-wrap: wrap;
  gap: 6px 16px;
}
li {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 0.92rem;
}
.ok-icon {
  color: var(--ok);
  flex: none;
}
.bad-icon {
  color: var(--err);
  flex: none;
}
li.bad {
  color: var(--err);
}
.name {
  font-weight: 550;
}
.path {
  overflow-wrap: anywhere;
}
</style>
