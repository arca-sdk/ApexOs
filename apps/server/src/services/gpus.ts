import type { AppGpus } from '@apexos/api-types';
import type { TrueNasClient } from '@apexos/truenas-client';
import { schemaHas } from '../truenas/helpers.ts';
import type { TnAppDetails, TnDockerConfig, TnGpuChoice, TnGpuValues } from '../truenas/types.ts';

/**
 * Graphics cards for apps. TrueNAS lists the cards apps can use in `app.gpu_choices`; an app's
 * `resources.gpus` passes Intel and AMD cards with `use_all_gpus` and NVIDIA cards one by one (by
 * PCI slot and UUID). NVIDIA cards need TrueNAS's NVIDIA driver, which ApexOs doesn't install.
 */
export interface GpuState {
  choices: TnGpuChoice[];
  summary: AppGpus;
}

export async function readGpus(client: TrueNasClient): Promise<GpuState> {
  const [choices, nvidiaPresent, docker] = await Promise.all([
    client.call<Record<string, TnGpuChoice>>('app.gpu_choices').catch(() => ({}) as Record<string, TnGpuChoice>),
    client.call<boolean>('docker.nvidia_present').catch(() => false),
    client.call<TnDockerConfig>('docker.config').catch(() => null),
  ]);
  const usable = Object.values(choices).filter((g) => !g.error && (g.vendor !== 'NVIDIA' || Boolean(g.vendor_specific_config?.uuid)));
  return {
    choices: usable,
    summary: {
      usable: usable.map((g) => g.description || `${g.vendor ?? 'Unknown'} graphics card`),
      nvidiaNeedsDriver: nvidiaPresent && !docker?.nvidia && !usable.some((g) => g.vendor === 'NVIDIA'),
    },
  };
}

/** `resources.gpus` that turns every usable card on (or off), keeping the rest of `current`. */
export function gpuValues(choices: TnGpuChoice[], enabled: boolean, current: TnGpuValues = {}): TnGpuValues {
  const nvidia = choices.filter((g) => g.vendor === 'NVIDIA');
  return {
    ...current,
    use_all_gpus: enabled && choices.some((g) => g.vendor !== 'NVIDIA'),
    nvidia_gpu_selection: Object.fromEntries(nvidia.map((g) => [g.pci_slot, { use_gpu: enabled, uuid: g.vendor_specific_config?.uuid ?? '' }])),
  };
}

export function gpuEnabled(values: TnGpuValues | undefined): boolean {
  return Boolean(values?.use_all_gpus || Object.values(values?.nvidia_gpu_selection ?? {}).some((s) => s.use_gpu));
}

/** Whether the catalog app's install schema has graphics card settings. */
export async function catalogAppUsesGpus(client: TrueNasClient, catalogApp: string, train: string): Promise<boolean> {
  const details = await client.call<TnAppDetails>('catalog.get_app_details', [catalogApp, { train }]).catch(() => null);
  const questions = details?.versions?.[details.latest_version]?.schema?.questions ?? [];
  return schemaHas(questions, 'resources.gpus');
}
