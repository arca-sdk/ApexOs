import type { Mock } from '../context.ts';
import { callError, queryFilter, validationError, validationErrors } from '../rpc.ts';
import type { TunableState } from '../state.ts';
import { argObj, type Obj } from '../util.ts';

/**
 * Kernel sysctls the simulated box knows, with their boot values. Docker turns IPv4 forwarding on
 * when the apps service starts, so `net.ipv4.ip_forward` is already 1 on a server with apps.
 */
const SYSCTLS: Record<string, string> = {
  'net.ipv4.ip_forward': '1',
  'net.ipv6.conf.all.forwarding': '0',
  'net.core.rmem_max': '212992',
  'net.core.wmem_max': '212992',
  'vm.swappiness': '1',
  'kernel.watchdog': '1',
};

const TYPES = ['SYSCTL', 'UDEV', 'ZFS'] as const;

function tunables(mock: Mock): TunableState[] {
  return (mock.state.tunables ??= []);
}

function emit(mock: Mock, msg: 'added' | 'changed' | 'removed', t: TunableState): void {
  mock.emit('tunable.query', msg, t.id, msg === 'removed' ? undefined : { ...t });
}

/** `tunable.*` (plugins/tunables.py): CRUD jobs serialized by the `tunable_crud` lock; SYSCTL values apply immediately. */
export function registerTunables(mock: Mock): void {
  const { server } = mock;

  server.method('tunable.query', (p) => queryFilter(tunables(mock).map((t) => ({ ...t })), p[0], p[1]));
  server.method('tunable.get_instance', (p) => queryFilter(tunables(mock).map((t) => ({ ...t })), [['id', '=', p[0]]], { get: true }));
  server.method('tunable.tunable_type_choices', () => Object.fromEntries(TYPES.map((t) => [t, t])));

  server.job('tunable.create', async (p, job) => {
    const data = argObj(p[0], 'tunable_create');
    const type = (data.type ?? 'SYSCTL') as TunableState['type'];
    const errors: Array<[string, string]> = [];
    if (!TYPES.includes(type)) errors.push(['tunable_create.type', "Input should be 'SYSCTL', 'UDEV' or 'ZFS'"]);
    if (typeof data.var !== 'string' || !data.var) errors.push(['tunable_create.var', 'Field required']);
    if (typeof data.value !== 'string') errors.push(['tunable_create.value', 'Field required']);
    if (errors.length) throw validationErrors(errors);
    const name = data.var as string;
    if (tunables(mock).some((t) => t.var === name)) throw validationError('tunable_create.var', `Tunable '${name}' already exists in database.`);
    if (type === 'SYSCTL' && !(name in SYSCTLS)) throw validationError('tunable_create.var', `Sysctl '${name}' does not exist in kernel.`);
    job.progress(50, 'Applying tunable');
    await job.sleep();
    const list = tunables(mock);
    const tunable: TunableState = {
      id: list.reduce((max, t) => Math.max(max, t.id), 0) + 1,
      type,
      var: name,
      value: data.value as string,
      orig_value: type === 'SYSCTL' ? SYSCTLS[name]! : '',
      comment: typeof data.comment === 'string' ? data.comment : '',
      enabled: data.enabled !== false,
      update_initramfs: data.update_initramfs !== false,
    };
    list.push(tunable);
    emit(mock, 'added', tunable);
    return { ...tunable };
  });

  server.job('tunable.update', async (p, job) => {
    const tunable = tunables(mock).find((t) => t.id === Number(p[0]));
    if (!tunable) throw callError('ENOENT', `Tunable ${String(p[0])} does not exist`);
    const data: Obj = argObj(p[1], 'tunable_update');
    if ('var' in data || 'type' in data) throw validationError('tunable_update.var', 'Extra inputs are not permitted');
    job.progress(50, 'Applying tunable');
    await job.sleep();
    if (typeof data.value === 'string') tunable.value = data.value;
    if (typeof data.comment === 'string') tunable.comment = data.comment;
    if (typeof data.enabled === 'boolean') tunable.enabled = data.enabled;
    emit(mock, 'changed', tunable);
    return { ...tunable };
  });

  server.job('tunable.delete', async (p, job) => {
    const list = tunables(mock);
    const index = list.findIndex((t) => t.id === Number(p[0]));
    if (index < 0) throw callError('ENOENT', `Tunable ${String(p[0])} does not exist`);
    job.progress(50, 'Resetting to the original value');
    await job.sleep();
    const [removed] = list.splice(index, 1);
    emit(mock, 'removed', removed!);
    return null;
  });
}
