import { randomBytes } from 'node:crypto';
import type { CronJobState, Mock } from '../context.ts';
import { runShell } from '../host.ts';
import { callError, queryFilter, validationError } from '../rpc.ts';
import { argObj, isObj, type Obj } from '../util.ts';

const DEFAULT_SCHEDULE = { minute: '00', hour: '*', dom: '*', month: '*', dow: '*' };

function render(job: CronJobState): Obj {
  return { ...job, schedule: { ...job.schedule } };
}

function validate(mock: Mock, data: Obj, attr: string, current?: CronJobState): CronJobState {
  const command = data.command ?? current?.command;
  const user = data.user ?? current?.user;
  if (typeof command !== 'string' || !command.trim()) throw validationError(`${attr}.command`, 'Field required');
  if (typeof user !== 'string' || !mock.state.users.some((u) => u.username === user)) {
    throw validationError(`${attr}.user`, 'Specified user does not exist');
  }
  const schedule = isObj(data.schedule) ? { ...DEFAULT_SCHEDULE, ...(current?.schedule ?? {}), ...(data.schedule as Obj) } : (current?.schedule ?? DEFAULT_SCHEDULE);
  return {
    id: current?.id ?? mock.nextCronId++,
    enabled: typeof data.enabled === 'boolean' ? data.enabled : (current?.enabled ?? true),
    stdout: typeof data.stdout === 'boolean' ? data.stdout : (current?.stdout ?? true),
    stderr: typeof data.stderr === 'boolean' ? data.stderr : (current?.stderr ?? false),
    schedule: schedule as CronJobState['schedule'],
    // The middleware strips newlines from cron commands.
    command: command.replace(/\n/g, ''),
    description: typeof data.description === 'string' ? data.description : (current?.description ?? ''),
    user,
  };
}

export function registerCron(mock: Mock): void {
  const { server } = mock;

  server.method('cronjob.query', (params) => queryFilter([...mock.cronjobs.values()].map(render), params[0], params[1]));

  server.method('cronjob.create', (params) => {
    const job = validate(mock, argObj(params[0], 'cron_job_create'), 'cron_job_create');
    mock.cronjobs.set(job.id, job);
    return render(job);
  });

  server.method('cronjob.update', (params) => {
    const current = mock.cronjobs.get(Number(params[0]));
    if (!current) throw callError('ENOENT', `CronJob ${String(params[0])} does not exist`);
    const job = validate(mock, argObj(params[1], 'cron_job_update'), 'cron_job_update', current);
    mock.cronjobs.set(job.id, job);
    return render(job);
  });

  server.method('cronjob.delete', (params) => {
    if (!mock.cronjobs.delete(Number(params[0]))) throw callError('ENOENT', `CronJob ${String(params[0])} does not exist`);
    return true;
  });

  // Mirrors plugins/cron.py: output is captured to the job log; if any output was produced and the
  // run-as user has an e-mail address, the middleware mails it to them.
  server.job('cronjob.run', async (params, job) => {
    const cron = mock.cronjobs.get(Number(params[0]));
    if (!cron) throw callError('ENOENT', `CronJob ${String(params[0])} does not exist`);
    if (params[1] === true && !cron.enabled) throw callError('EINVAL', 'Cron job is disabled');
    const command = `${cron.command}${cron.stdout ? ' > /dev/null' : ''}${cron.stderr ? ' 2> /dev/null' : ''}`;
    job.progress(10, 'Executing Cron Task');
    await job.sleep();
    const result = runShell(mock, cron.user, cron.command);
    const output = cron.stdout ? '' : result.output;
    job.log(output);
    job.progress(85, 'Executed Cron Task');
    if (output) {
      const email = mock.state.users.find((u) => u.username === cron.user)?.email;
      if (email) mock.mailLog.push({ to: email, subject: 'Cron Job Run', text: output });
      job.log(`Executed CronTask - ${command}: ${output}`);
    }
    if (result.code) throw callError('EFAULT', `CronTask "${command}" exited with ${result.code} (non-zero) exit status.`);
    job.progress(100, 'Execution of Cron Task complete.');
    return null;
  });

  server.method('core.job_download_logs', (params) => {
    const id = Number(params[0]);
    const job = server.getJob(id);
    if (!job) throw callError('ENOENT', `Job ${String(params[0])} not found`);
    if (!job.logs_path) throw callError('EFAULT', 'This job has no logs');
    const token = randomBytes(16).toString('hex');
    const buffered = params[2] === true;
    mock.downloads.set(token, { jobId: id, expires: Date.now() + (buffered ? 3_600_000 : 60_000) });
    return `/_download/${id}?auth_token=${token}`;
  });

  // GET /_download/<job> (job logs and core.download outputs) is served by download.ts.
}
