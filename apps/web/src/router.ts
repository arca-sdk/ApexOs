import { createRouter, createWebHistory, type RouteLocationNormalized } from 'vue-router';
import { refreshStatus, session } from './lib/api.ts';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/welcome', name: 'welcome', component: () => import('./views/WelcomeView.vue'), meta: { public: true, bare: true } },
    { path: '/login', name: 'login', component: () => import('./views/LoginView.vue'), meta: { public: true, bare: true } },
    { path: '/connect', name: 'connect', component: () => import('./views/ConnectView.vue'), meta: { bare: true } },
    { path: '/setup', name: 'setup', component: () => import('./views/SetupView.vue'), meta: { bare: true } },
    { path: '/', name: 'dashboard', component: () => import('./views/DashboardView.vue') },
    { path: '/storage', name: 'storage', component: () => import('./views/StorageView.vue') },
    { path: '/folders', name: 'folders', component: () => import('./views/FoldersView.vue') },
    { path: '/files', name: 'files', component: () => import('./views/FilesView.vue') },
    { path: '/users', name: 'users', component: () => import('./views/UsersView.vue') },
    { path: '/backups', name: 'backups', component: () => import('./views/BackupsView.vue') },
    { path: '/apps', name: 'apps', component: () => import('./views/AppsView.vue') },
    { path: '/apps/catalog', name: 'app-catalog', component: () => import('./views/AppCatalogView.vue') },
    { path: '/settings', name: 'settings', component: () => import('./views/SettingsView.vue') },
    { path: '/remote', name: 'remote', component: () => import('./views/RemoteAccessView.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

/** Sends the user to the first unfinished onboarding step. */
function onboardingRedirect(to: RouteLocationNormalized): string | undefined {
  if (session.needsAccount) return to.name === 'welcome' ? undefined : '/welcome';
  if (!session.authenticated) return to.meta.public ? undefined : `/login`;
  if (!session.truenasConfigured || !session.truenasConnected) return to.name === 'connect' ? undefined : '/connect';
  if (!session.setupComplete) return to.name === 'setup' ? undefined : '/setup';
  if (to.name === 'welcome' || to.name === 'login' || to.name === 'setup') return '/';
  return undefined;
}

router.beforeEach(async (to) => {
  if (!session.loaded || to.meta.public || to.name === 'connect' || to.name === 'setup') {
    try {
      await refreshStatus();
    } catch {
      // Server unreachable; let the view render and show its own error.
      return true;
    }
  }
  return onboardingRedirect(to) ?? true;
});
