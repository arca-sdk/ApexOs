<script setup lang="ts">
/** "View drives": every member of a pool as a tile, with Replace, Add drive and Add spare. */
import { computed } from 'vue';
import { LifeBuoy, Plus } from 'lucide-vue-next';
import type { Drive, Pool } from '@hearth/api-types';
import Modal from '../Modal.vue';
import DriveTile from './DriveTile.vue';
import ScanProgress from './ScanProgress.vue';
import { toleranceText } from '../../lib/format.ts';

const props = defineProps<{ pool: Pool }>();
const emit = defineEmits<{ close: []; replace: [drive: Drive]; addDrive: []; addSpare: [] }>();

const rebuilding = computed(() => props.pool.scan?.kind === 'resilver' && props.pool.scan.state === 'running');
const canReplaceAny = computed(() => props.pool.drives.length >= 2);
const replaceBlocked = computed(() => (rebuilding.value ? 'Wait for the rebuild to finish first.' : null));
const missingCount = computed(() => props.pool.drives.filter((d) => d.missing).length);
</script>

<template>
  <Modal :title="`Drives in ${pool.displayName}`" wide @close="emit('close')">
    <div class="row wrap small" style="--gap: 6px 16px">
      <span><span class="muted">Layout:</span> {{ pool.layout.label }}</span>
      <span><span class="muted">Protection:</span> {{ toleranceText(pool.layout.faultTolerance) }}</span>
    </div>
    <ScanProgress :scan="pool.scan" />
    <p v-if="missingCount" class="callout err">
      {{ missingCount === 1 ? 'A drive is' : `${missingCount} drives are` }} missing. Use the serial number below to find
      {{ missingCount === 1 ? 'it' : 'them' }} in the case, check the cables, or replace {{ missingCount === 1 ? 'it' : 'them' }}.
    </p>
    <p v-if="pool.health === 'degraded' || pool.health === 'rebuilding'" class="small muted">
      Replace one drive at a time, and avoid restarting the server until the pool is healthy again.
    </p>

    <div class="tiles">
      <DriveTile
        v-for="d in pool.drives"
        :key="d.identifier"
        :drive="d"
        :rebuilding="rebuilding"
        :can-replace="canReplaceAny || d.missing"
        :replace-blocked="replaceBlocked"
        @replace="emit('replace', d)"
      />
    </div>

    <section class="stack" style="--gap: 10px">
      <h3>Hot spares</h3>
      <p v-if="!pool.spares.length" class="small muted">
        {{
          (pool.layout.faultTolerance ?? 0) > 0
            ? 'No spare yet. A spare waits unused and takes over automatically when a drive fails.'
            : 'Spares only help pools that have protection.'
        }}
      </p>
      <div v-else class="tiles">
        <DriveTile v-for="d in pool.spares" :key="d.identifier" :drive="d" />
      </div>
    </section>

    <template #footer>
      <button v-if="pool.layout.expandable" class="btn" @click="emit('addDrive')"><Plus :size="15" aria-hidden="true" /> Add a drive</button>
      <button v-if="(pool.layout.faultTolerance ?? 0) > 0" class="btn" @click="emit('addSpare')"><LifeBuoy :size="15" aria-hidden="true" /> Add a spare</button>
      <button class="btn primary" @click="emit('close')">Done</button>
    </template>
  </Modal>
</template>

<style scoped>
.tiles {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(auto-fill, minmax(min(230px, 100%), 1fr));
}
</style>
