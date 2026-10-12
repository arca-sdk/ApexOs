<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { Boxes, Flame, FolderOpen, HardDrive, LayoutDashboard, LogOut, Settings, Users } from 'lucide-vue-next';
import { api, session } from '../lib/api.ts';
import { live } from '../lib/events.ts';
import TaskTray from './TaskTray.vue';
import NotificationBell from './notifications/NotificationBell.vue';

const router = useRouter();

const nav = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/storage', label: 'Storage', icon: HardDrive },
  { to: '/folders', label: 'Folders', icon: FolderOpen },
  { to: '/users', label: 'Users', icon: Users },
  { to: '/apps', label: 'Apps', icon: Boxes },
  { to: '/settings', label: 'Settings', icon: Settings },
];

const connectionLabel = computed(() => (live.connected ? 'Connected' : 'Reconnecting…'));

async function logout() {
  await api.post('/auth/logout');
  session.authenticated = false;
  router.replace('/login');
}
</script>

<template>
  <div class="layout">
    <aside class="sidebar">
      <div class="brand">
        <Flame :size="22" class="brand-icon" />
        <div style="min-width: 0">
          <div class="brand-name">Hearth</div>
          <div class="server-name small muted">{{ session.serverName || 'Home server' }}</div>
        </div>
        <NotificationBell />
      </div>
      <nav>
        <RouterLink v-for="item in nav" :key="item.to" :to="item.to" class="nav-link" :exact-active-class="item.to === '/' ? 'active' : ''" :active-class="item.to === '/' ? '' : 'active'">
          <component :is="item.icon" :size="18" />
          <span>{{ item.label }}</span>
        </RouterLink>
      </nav>
      <div class="spacer" />
      <div class="sidebar-footer stack" style="--gap: 10px">
        <span v-if="session.demo" class="badge info">Demo mode — simulated TrueNAS</span>
        <div class="row small muted" style="--gap: 8px">
          <span class="dot" :class="{ on: live.connected }" />
          {{ connectionLabel }}
          <span class="spacer" />
          <button class="btn ghost small" title="Sign out" aria-label="Sign out" @click="logout"><LogOut :size="16" /></button>
        </div>
      </div>
    </aside>
    <main class="content">
      <slot />
    </main>
    <TaskTray />
  </div>
</template>

<style scoped>
.layout {
  display: grid;
  grid-template-columns: 240px 1fr;
  min-height: 100vh;
}
.sidebar {
  position: sticky;
  top: 0;
  height: 100vh;
  display: flex;
  flex-direction: column;
  padding: 20px 14px;
  border-right: 1px solid var(--border);
  background: var(--surface);
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 8px 22px;
}
.brand-icon {
  color: var(--accent);
}
.brand-name {
  font-weight: 700;
  font-size: 1.1rem;
}
.server-name {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.nav-link {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 12px;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  font-weight: 550;
}
.nav-link:hover {
  background: var(--surface-2);
  color: var(--text);
  text-decoration: none;
}
.nav-link.active {
  background: var(--accent-soft);
  color: var(--accent-strong);
}
.sidebar-footer {
  padding: 0 8px;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--warn);
}
.dot.on {
  background: var(--ok);
}
.content {
  padding: 32px 40px 64px;
  max-width: 1200px;
  width: 100%;
}
@media (max-width: 800px) {
  .layout {
    grid-template-columns: 1fr;
  }
  .sidebar {
    position: static;
    height: auto;
    flex-direction: row;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .brand {
    padding: 0 8px;
  }
  nav {
    flex-direction: row;
    flex-wrap: wrap;
  }
  .nav-link span {
    display: none;
  }
  .content {
    padding: 20px 16px 48px;
  }
}
</style>
