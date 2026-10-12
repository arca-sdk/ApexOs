<script setup lang="ts">
/**
 * Settings: a list of sections on the left, the selected one on the right. Each section has its own
 * URL (`/settings?section=network`) so it can be linked to and survives a reload.
 */
import { computed, nextTick, onMounted, ref, watch, type Component } from 'vue';
import { useRoute } from 'vue-router';
import { Download, Info, MapPin, Network, Plug, Power, Server, SlidersHorizontal, User } from 'lucide-vue-next';
import AboutSection from '../components/settings/AboutSection.vue';
import AccountSection from '../components/settings/AccountSection.vue';
import GeneralSection from '../components/settings/GeneralSection.vue';
import LocationsSection from '../components/settings/LocationsSection.vue';
import NetworkSection from '../components/settings/NetworkSection.vue';
import PowerSection from '../components/settings/PowerSection.vue';
import PreferencesSection from '../components/settings/PreferencesSection.vue';
import TrueNasSection from '../components/settings/TrueNasSection.vue';
import UpdatesSection from '../components/settings/UpdatesSection.vue';

interface Section {
  id: string;
  label: string;
  hint: string;
  icon: Component;
  component: Component;
}

const groups: { title: string; sections: Section[] }[] = [
  {
    title: 'System',
    sections: [
      { id: 'general', label: 'Name & time zone', hint: 'Server name and time zone', icon: Server, component: GeneralSection },
      { id: 'network', label: 'Network', hint: 'IP addresses and network ports', icon: Network, component: NetworkSection },
      { id: 'updates', label: 'Updates', hint: 'TrueNAS version and updates', icon: Download, component: UpdatesSection },
      { id: 'power', label: 'Power', hint: 'Restart or shut down', icon: Power, component: PowerSection },
      { id: 'truenas', label: 'TrueNAS', hint: 'Connection and the TrueNAS UI', icon: Plug, component: TrueNasSection },
    ],
  },
  {
    title: 'Applications',
    sections: [{ id: 'locations', label: 'Locations', hint: 'Where apps keep their files', icon: MapPin, component: LocationsSection }],
  },
  {
    title: 'You',
    sections: [
      { id: 'preferences', label: 'Preferences', hint: 'Temperature unit', icon: SlidersHorizontal, component: PreferencesSection },
      { id: 'account', label: 'Your account', hint: 'Your ApexOs password', icon: User, component: AccountSection },
      { id: 'about', label: 'About', hint: 'License and credits', icon: Info, component: AboutSection },
    ],
  },
];

const all = groups.flatMap((g) => g.sections);
const route = useRoute();
const active = computed(() => all.find((s) => s.id === route.query.section) ?? all[0]!);

/** On narrow screens the sections become a horizontal strip; keep the selected one visible. */
const master = ref<HTMLElement | null>(null);
async function revealActive() {
  await nextTick();
  master.value?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
watch(() => active.value.id, revealActive);
onMounted(revealActive);
</script>

<template>
  <div class="page-header">
    <div>
      <h1>Settings</h1>
      <p class="subtitle">Your server, its connection to TrueNAS, and your account.</p>
    </div>
  </div>

  <div class="settings">
    <nav ref="master" class="master" aria-label="Settings sections">
      <div v-for="g in groups" :key="g.title" class="group">
        <h2 class="group-title">{{ g.title }}</h2>
        <ul>
          <li v-for="s in g.sections" :key="s.id">
            <RouterLink
              :to="{ path: '/settings', query: { section: s.id } }"
              class="item"
              :class="{ active: active.id === s.id }"
              :aria-current="active.id === s.id ? 'page' : undefined"
              replace
            >
              <component :is="s.icon" :size="18" class="item-icon" />
              <span class="stack" style="--gap: 0; min-width: 0">
                <span class="item-label">{{ s.label }}</span>
                <span class="item-hint small muted">{{ s.hint }}</span>
              </span>
            </RouterLink>
          </li>
        </ul>
      </div>
    </nav>

    <div class="detail">
      <component :is="active.component" :key="active.id" />
    </div>
  </div>
</template>

<style scoped>
.settings {
  display: grid;
  grid-template-columns: 250px minmax(0, 1fr);
  gap: 24px;
  align-items: start;
}
.master {
  position: sticky;
  top: 24px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.group ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.group-title {
  font-size: 0.78rem;
  font-weight: 650;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  margin: 0 0 6px 10px;
}
.item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  color: var(--text);
}
.item:hover {
  background: var(--surface-2);
  text-decoration: none;
}
.item:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.item.active {
  background: var(--accent-soft);
}
.item.active .item-icon {
  color: var(--accent-strong);
}
.item-icon {
  color: var(--text-muted);
  flex-shrink: 0;
}
.item-label {
  font-weight: 550;
}
.item-hint {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.detail {
  min-width: 0;
}

@media (max-width: 860px) {
  .settings {
    grid-template-columns: 1fr;
  }
  .master {
    position: static;
    flex-direction: row;
    gap: 6px;
    overflow-x: auto;
    padding-bottom: 6px;
    -webkit-overflow-scrolling: touch;
  }
  .group {
    display: contents;
  }
  .group-title {
    display: none;
  }
  .group ul {
    flex-direction: row;
    gap: 6px;
  }
  .item {
    padding: 6px 12px;
    border: 1px solid var(--border);
    border-radius: 999px;
    white-space: nowrap;
    gap: 6px;
  }
  .item-hint {
    display: none;
  }
}
</style>
