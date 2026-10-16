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

/**
 * Settings some apps need besides `resources.gpus` to really use the card, as whole top-level keys (TrueNAS
 * replaces each key that is sent). Immich's machine learning only uses a card with the matching image: CUDA for
 * NVIDIA, OpenVINO for Intel, ROCm for AMD (only when TrueNAS found the ROCm device, `/dev/kfd`).
 */
export function gpuAppValues(catalogApp: string | null | undefined, choices: TnGpuChoice[], enabled: boolean, values: Record<string, unknown>): Record<string, unknown> {
  if (catalogApp !== 'immich') return {};
  const immich = values.immich && typeof values.immich === 'object' ? (values.immich as Record<string, unknown>) : {};
  const resources = values.resources && typeof values.resources === 'object' ? (values.resources as { gpus?: TnGpuValues }) : {};
  const vendor = (re: RegExp) => choices.some((g) => re.test(g.vendor ?? ''));
  let image = 'ml_image';
  if (enabled) {
    if (vendor(/nvidia/i)) image = 'ml_cuda_image';
    else if (vendor(/intel/i)) image = 'ml_openvino_image';
    else if (vendor(/amd|advanced micro/i) && resources.gpus?.kfd_device_exists) image = 'ml_rocm_image';
  }
  return { immich: { ...immich, ml_image_selector: image } };
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
