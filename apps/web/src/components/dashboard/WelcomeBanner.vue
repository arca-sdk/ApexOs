<script setup lang="ts">
/** First-run welcome with shortcuts; hidden for good once dismissed (per browser). */
import { ref } from 'vue';
import { Boxes, FolderOpen, HardDrive, PartyPopper, Users, X } from 'lucide-vue-next';

const KEY = 'apexos.welcomeDismissed';
const visible = ref(localStorage.getItem(KEY) !== '1');

function dismiss() {
  localStorage.setItem(KEY, '1');
  visible.value = false;
}

const shortcuts = [
  { to: '/storage', icon: HardDrive, title: 'Storage', text: 'See your drives and how much room is left' },
  { to: '/folders', icon: FolderOpen, title: 'Folders', text: 'Make shared folders for photos, documents and more' },
  { to: '/users', icon: Users, title: 'Users', text: 'Add the people who can open those folders' },
  { to: '/apps/catalog', icon: Boxes, title: 'Apps', text: 'Install media servers, photo backup and more' },
];
</script>

<template>
  <section v-if="visible" class="card welcome" aria-labelledby="welcome-title">
    <div class="head">
      <PartyPopper :size="22" class="icon" aria-hidden="true" />
      <div class="stack" style="--gap: 2px">
        <h2 id="welcome-title">Welcome to your home server</h2>
        <p class="muted small">Setup is done. Here are a few good places to start.</p>
      </div>
      <span class="spacer" />
      <button class="btn ghost small" aria-label="Dismiss welcome message" title="Dismiss" @click="dismiss"><X :size="18" /></button>
    </div>
    <ul class="shortcuts">
      <li v-for="s in shortcuts" :key="s.to">
        <RouterLink :to="s.to" class="shortcut">
          <component :is="s.icon" :size="20" class="s-icon" aria-hidden="true" />
          <span class="stack" style="--gap: 0">
            <strong>{{ s.title }}</strong>
            <span class="small muted">{{ s.text }}</span>
          </span>
        </RouterLink>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.welcome {
  background: linear-gradient(135deg, var(--accent-soft), var(--surface) 70%);
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}
.icon {
  color: var(--accent);
  flex: none;
  margin-top: 2px;
}
.shortcuts {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 10px;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
}
.shortcut {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 12px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  height: 100%;
}
.shortcut:hover {
  text-decoration: none;
  border-color: var(--accent);
}
.s-icon {
  flex: none;
  color: var(--accent);
  margin-top: 2px;
}
</style>
