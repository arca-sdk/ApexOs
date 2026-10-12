<script setup lang="ts">
import { computed, ref } from 'vue';
import { Boxes, FolderSearch, Globe, History, Lock, LockKeyhole, MapPin, Pencil, ShieldCheck, Trash2, Unlock, User } from 'lucide-vue-next';
import type { Folder } from '@apexos/api-types';
import { formatBytes } from '../../lib/format.ts';
import FolderBackupsCard from '../backups/FolderBackupsCard.vue';
import ConnectionAddress from './ConnectionAddress.vue';
import EncryptionSection from './EncryptionSection.vue';
import SidePanel from './SidePanel.vue';
import { isConverting, ownsKey } from './encryptionRules.ts';
import { LEVEL_LABELS, useLink } from './folderRules.ts';

const props = defineProps<{ folder: Folder }>();
const emit = defineEmits<{ close: []; edit: []; delete: [] }>();

const quotaPercent = computed(() =>
  props.folder.quotaBytes ? Math.min(100, Math.round((props.folder.usedBytes / props.folder.quotaBytes) * 100)) : null,
);
const meterClass = computed(() => (quotaPercent.value === null ? '' : quotaPercent.value >= 95 ? 'err' : quotaPercent.value >= 80 ? 'warn' : ''));

/** Unshared system folders (e.g. app data) must not be edited: saving would share them. */
const editable = computed(() => props.folder.shared || !props.folder.system);

const locked = computed(() => !!props.folder.encryption?.locked);
const converting = computed(() => isConverting(props.folder));
/** Why Edit/Delete are unavailable right now (shown as the button's description). */
const convertHint = computed(() =>
  props.folder.conversion?.state === 'running' ? 'Wait until encryption is turned on.' : 'Retry or discard turning on encryption first.',
);
const editBlocked = computed(() => (converting.value ? convertHint.value : locked.value ? 'Unlock the folder to change its settings.' : null));
const lockable = computed(() => ownsKey(props.folder) && props.folder.encryption?.mode === 'passphrase' && !converting.value);
const encryption = ref<InstanceType<typeof EncryptionSection> | null>(null);
</script>

<template>
  <SidePanel :title="folder.name" :subtitle="`On ${folder.poolDisplayName}`" @close="emit('close')">
    <template #badges>
      <div class="row wrap" style="--gap: 6px; margin-top: 6px">
        <template v-if="folder.shared">
          <span v-if="folder.access === 'public'" class="badge info"><Globe :size="12" /> Public</span>
          <span v-else class="badge"><Lock :size="12" /> Private</span>
        </template>
        <span v-else class="badge">Not shared</span>
        <span v-if="folder.timeMachine" class="badge accent"><History :size="12" /> Time Machine</span>
        <span v-if="locked" class="badge warn"><LockKeyhole :size="12" /> Locked</span>
        <span v-else-if="folder.encryption && folder.encryption.mode !== 'none'" class="badge ok"><ShieldCheck :size="12" /> Encrypted</span>
        <span v-if="folder.system" class="badge">Managed by ApexOs</span>
      </div>
    </template>

    <section class="stack" style="--gap: 10px" aria-labelledby="fp-connect">
      <h3 id="fp-connect">Open it from another computer</h3>
      <p v-if="locked" class="callout warn">
        This folder is locked, so its network share is hidden and can’t be opened from any computer. Unlock it to use it again.
      </p>
      <ConnectionAddress v-else-if="folder.shared" :folder="folder" />
      <p v-else-if="folder.system" class="callout">ApexOs keeps app data here, so this folder isn’t shared on your network.</p>
      <p v-else class="callout warn">This folder isn’t shared on your network right now. Choose <strong>Edit</strong> and save to share it again.</p>
      <p v-if="folder.timeMachine" class="small muted">
        To back up a Mac here, open <em>System Settings → General → Time Machine</em>, choose <em>Add Backup Disk</em> and pick
        <strong>{{ folder.name }}</strong>.
      </p>
    </section>

    <EncryptionSection ref="encryption" :folder="folder" />

    <section class="stack" style="--gap: 8px" aria-labelledby="fp-size">
      <h3 id="fp-size">Space</h3>
      <p>
        <strong>{{ formatBytes(folder.usedBytes) }}</strong> used
        <span v-if="folder.quotaBytes" class="muted">of a {{ formatBytes(folder.quotaBytes) }} limit</span>
        <span v-else class="muted">· no limit, can use the pool’s free space</span>
      </p>
      <div
        v-if="quotaPercent !== null"
        class="meter"
        :class="meterClass"
        role="meter"
        :aria-valuenow="quotaPercent"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-label="Share of the storage limit used"
      >
        <span :style="{ width: `${quotaPercent}%` }" />
      </div>
      <p v-if="quotaPercent !== null && quotaPercent >= 95" class="small" style="color: var(--err)">
        Almost full. Raise the limit or remove some files.
      </p>
    </section>

    <section v-if="folder.shared" class="stack" style="--gap: 8px" aria-labelledby="fp-who">
      <h3 id="fp-who">Who can open it</h3>
      <p v-if="folder.access === 'public'" class="small">
        Everyone on your home network can open, add, change and delete files here. No password is needed.
      </p>
      <template v-else>
        <ul v-if="folder.users.length" class="list">
          <li v-for="u in folder.users" :key="u.username" class="row" style="--gap: 10px">
            <User :size="16" class="muted" />
            <RouterLink :to="{ path: '/users', query: { user: u.username } }">{{ u.username }}</RouterLink>
            <span class="spacer" />
            <span class="badge" :class="u.level === 'full' ? 'ok' : ''">{{ LEVEL_LABELS[u.level] }}</span>
          </li>
        </ul>
        <p class="small muted">
          {{ folder.users.length ? 'The server’s admin account also has full access.' : 'Only the server’s admin account can open it. Choose Edit to let other people in.' }}
        </p>
      </template>
    </section>

    <section class="stack" style="--gap: 8px" aria-labelledby="fp-used">
      <h3 id="fp-used">Used by</h3>
      <ul v-if="folder.usedBy.length" class="list">
        <li v-for="use in folder.usedBy" :key="`${use.type}-${use.id}`" class="row" style="--gap: 10px">
          <Boxes v-if="use.type === 'app'" :size="16" class="muted" />
          <MapPin v-else :size="16" class="muted" />
          <RouterLink :to="useLink(use)">{{ use.name }}</RouterLink>
          <span class="small muted">{{ use.type === 'app' ? 'App' : 'Location' }}</span>
        </li>
      </ul>
      <p v-else class="small muted">No apps or locations use this folder.</p>
    </section>

    <FolderBackupsCard :folder="folder" />

    <section class="stack" style="--gap: 6px" aria-labelledby="fp-details">
      <h3 id="fp-details">Details</h3>
      <dl class="details small">
        <dt>Pool</dt>
        <dd>{{ folder.poolDisplayName }}</dd>
        <dt>Path on the server</dt>
        <dd class="mono">{{ folder.path }}</dd>
      </dl>
    </section>

    <template #footer>
      <RouterLink class="btn" :to="{ path: '/files', query: { folder: folder.name } }"><FolderSearch :size="16" /> Browse</RouterLink>
      <button v-if="editable" class="btn" :disabled="!!editBlocked" :title="editBlocked ?? undefined" @click="emit('edit')"><Pencil :size="16" /> Edit</button>
      <template v-if="lockable">
        <button v-if="locked" class="btn" @click="encryption?.openUnlock()"><Unlock :size="16" /> Unlock</button>
        <button v-else class="btn" @click="encryption?.openLock()"><Lock :size="16" /> Lock</button>
      </template>
      <span class="spacer" />
      <button class="btn danger" :disabled="converting" :title="converting ? convertHint : undefined" @click="emit('delete')"><Trash2 :size="16" /> Delete</button>
      <p v-if="editBlocked" class="small muted footer-note">{{ editBlocked }}</p>
    </template>
  </SidePanel>
</template>

<style scoped>
.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.details {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 14px;
  margin: 0;
}
.details dt {
  color: var(--text-muted);
}
.details dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.footer-note {
  flex-basis: 100%;
}
</style>
