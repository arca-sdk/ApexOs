import type { Mock } from '../context.ts';
import { callError, queryFilter, validationError } from '../rpc.ts';
import type { ServiceState } from '../state.ts';
import { argObj, isObj, seeded } from '../util.ts';

const VERBS = ['START', 'STOP', 'RESTART', 'RELOAD'];

export function renderService(s: ServiceState): object {
  const base = 1000 + Math.floor(seeded(s.service) * 20000);
  return { id: s.id, service: s.service, enable: s.enable, state: s.state, pids: s.state === 'RUNNING' ? [base, base + 3] : [] };
}

export function setServiceState(mock: Mock, name: string, state: ServiceState['state'], enable?: boolean): void {
  const svc = mock.state.services.find((s) => s.service === name);
  if (!svc) return;
  svc.state = state;
  if (enable !== undefined) svc.enable = enable;
  mock.emit('service.query', 'changed', svc.id, renderService(svc));
}

/** Applies a control verb; returns false when the service cannot run in the current configuration. */
function control(mock: Mock, svc: ServiceState, verb: string): boolean {
  if (svc.service === 'docker') {
    const d = mock.state.docker;
    if (!d.pool) return verb === 'STOP';
    if (verb === 'STOP') {
      d.status = 'STOPPED';
      for (const a of mock.state.apps) if (a.pool === d.pool && a.state !== 'STOPPED') a.state = 'STOPPED';
    } else d.status = 'RUNNING';
    mock.emit('docker.state', 'changed', null, { status: d.status, description: d.description });
  }
  if (verb === 'STOP') svc.state = 'STOPPED';
  else svc.state = 'RUNNING';
  mock.emit('service.query', 'changed', svc.id, renderService(svc));
  return true;
}

export function registerServices(mock: Mock): void {
  const { server } = mock;
  const find = (idOrName: unknown) => {
    const svc = mock.state.services.find((s) => s.id === idOrName || s.service === idOrName);
    if (!svc) throw callError('ENOENT', `${String(idOrName)}: service not found`);
    return svc;
  };
  server.method('service.query', (p) => queryFilter(mock.state.services.map(renderService), p[0], p[1]));
  server.method('service.get_instance', (p) => queryFilter(mock.state.services.map(renderService), [['id', '=', p[0]]], { get: true }));
  server.method('service.update', (p) => {
    const svc = find(p[0]);
    const data = argObj(p[1], 'service_update');
    if (typeof data.enable !== 'boolean') throw validationError('service_update.enable', 'Field required');
    svc.enable = data.enable;
    mock.emit('service.query', 'changed', svc.id, renderService(svc));
    return svc.id;
  });
  server.job(
    'service.control',
    async (p, job) => {
      const svc = find(p[1]);
      const verb = String(p[0]);
      const opts = isObj(p[2]) ? p[2] : {};
      job.progress(30, `${verb.charAt(0)}${verb.slice(1).toLowerCase()}ing ${svc.service}`);
      await job.sleep();
      const ok = control(mock, svc, verb);
      if (!ok && opts.silent === false) throw callError('EFAULT', `The ${svc.service} service failed to start: no pool is configured for applications`);
      return ok;
    },
    (p) => {
      if (!VERBS.includes(String(p[0]))) throw validationError('service.control.verb', `Input should be ${VERBS.map((v) => `'${v}'`).join(', ')}`);
      if (typeof p[1] !== 'string') throw validationError('service.control.service', 'Field required');
    },
  );
  // Deprecated (removed in v26.04) but still callable in 25.10; not jobs.
  for (const verb of ['start', 'stop', 'restart', 'reload']) {
    server.method(`service.${verb}`, (p) => control(mock, find(p[0]), verb.toUpperCase()));
  }
  server.method('service.started', (p) => find(p[0]).state === 'RUNNING');
  server.method('service.started_or_enabled', (p) => {
    const svc = find(p[0]);
    return svc.state === 'RUNNING' || svc.enable;
  });
}
