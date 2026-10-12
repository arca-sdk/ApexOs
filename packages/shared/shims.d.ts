// ApexOs addition (not part of upstream hexos-shared): ambient declarations for globals the
// upstream code expects from its Nuxt host application, so the types compile standalone.
declare function useI18n(): { t: (key: string, ...args: unknown[]) => string };
