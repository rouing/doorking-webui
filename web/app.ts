/**
 * @module web/app
 *
 * The server as one object: built from its dependencies (no I/O in the constructor), started and stopped explicitly,
 * so tests can run a real server on a test database and a spare port.
 */
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import * as dk from '../index.ts';
import type { Services } from './context.ts';
import { runStartupMigrations } from './migrations.ts';
import { createModules, createRoutes, type Modules } from './modules.ts';
import { createFastifyServer, markStepUp } from './requests.ts';
import { logger } from '../src/logging.ts';

export interface ApplicationOptions extends Omit<Services, 'store'> {
  storeOptions: dk.StoreOptions;
}

/**
 * How long stop() waits for a running gate connection and its schedule, so a send isn't cut off before its check
 * pull. Pulls take about 1.5-2 minutes; doorking.service's TimeoutStopSec (330 s) must stay longer.
 */
const STOP_WAIT_MS = 5 * 60000;

export class Application {
  private store: dk.Store | null = null;
  private modules: Modules | null = null;
  private fastify: FastifyInstance | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private stopping = false;
  private readonly options: ApplicationOptions;

  constructor(options: ApplicationOptions) {
    this.options = options;
  }

  /** Opens the database, runs the one-time migrations, listens on server.port and starts the background work. */
  async start(): Promise<void> {
    const { storeOptions, ...services } = this.options;
    this.store = await dk.openStore(storeOptions).catch((err: Error) => { throw new Error(`Database not available: ${err.message}`); });
    const modules = createModules({ ...services, store: this.store });
    this.modules = modules;
    const routes = createRoutes(modules);
    markStepUp(routes);
    await runStartupMigrations(modules);
    await this.offerFirstSetup(modules);
    this.fastify = await createFastifyServer(modules, routes, () => this.stopping);
    await this.fastify.listen({ port: modules.context.PORT, host: modules.context.HOST });
    this.announce(modules);
    this.startBackgroundWork(modules);
  }

  /**
   * Refuses new requests, lets schedules start nothing new, waits up to STOP_WAIT_MS for the running gate connection
   * (and the schedule it belongs to), stops snapshot runs and camera bridges, waits (within the same limit) for an email
   * being sent, and closes the database.
   *
   * @param [reason] - Reason.
   */
  async stop(reason = 'stop'): Promise<void> {
    if (!this.modules || this.stopping) return;
    const { context, jobs, mail, snapshots, webhooks } = this.modules;
    this.stopping = true;
    const running = jobs.runningJobs().map((job) => `${job.what} of gate ${job.phoneNumber}`).join(', ');
    logger('server').info`${reason}: shutting down${running ? `, waiting for the running ${running}` : ''}`;
    for (const timer of this.timers) clearInterval(timer);
    jobs.stopNewJobs();
    this.fastify?.server.close();
    this.fastify?.server.closeIdleConnections();
    snapshots.stopAllSnapshots();
    const until = Date.now() + STOP_WAIT_MS;
    while (!jobs.jobsIdle() && Date.now() < until) await new Promise((resolve) => { setTimeout(resolve, 500); });
    if (!jobs.jobsIdle()) {
      const still = jobs.runningJobs().map((job) => `${job.what} of gate ${job.phoneNumber}`).join(', ');
      logger('server').warn`Stopped without waiting longer for the ${still || 'scheduled transfer'}`;
    }
    context.cameras.stopAll();
    await Promise.race([Promise.all([mail.mailIdle(), webhooks.webhooksIdle()]), new Promise((resolve) => { setTimeout(resolve, Math.max(0, until - Date.now())).unref(); })]);
    this.fastify?.server.closeAllConnections();
    await this.fastify?.close().catch(() => {});
    await dk.closeStore(this.store!).catch(context.logged('server', 'Database not closed'));
  }

  /**
   * The database the server uses (once started), for tests and tools that work alongside it.
   *
   * @returns `dk.Store` result.
   */
  db(): dk.Store {
    return this.store!;
  }

  /**
   * The port the server listens on (useful when the config asked for port 0).
   *
   * @returns `number` result.
   */
  port(): number {
    return (this.fastify!.server.address() as AddressInfo).port;
  }

  /**
   * While no account exists, creating the first one needs a code printed only to the console (journalctl), so a
   * stranger reaching a fresh public install can't claim it first.
   *
   * @param modules - Composed server modules (`context`, `auth`, `mail`, `editing`, `snapshots`, `jobs`).
   */
  private async offerFirstSetup(modules: Modules): Promise<void> {
    if (await dk.userCount(modules.context.store) !== 0) return;
    console.log(`No account exists yet. First-account setup code: ${modules.auth.newSetupCode()} (enter it on the page to create the first account, or run: node cli.ts create-admin <username>)`);
  }

  private announce(modules: Modules): void {
    const { config, PUBLIC_HOST, ROOT } = modules.context;
    console.log(`DoorKing web UI: http://localhost:${this.port()}${PUBLIC_HOST ? ` and https://${PUBLIC_HOST}` : ''}  (config ${config.file || 'none, defaults'}, media in ${ROOT})`);
    logger('server').info`Started on port ${this.port()}: ${JSON.stringify(dk.maskedConfig(config))}`;
  }

  private startBackgroundWork(modules: Modules): void {
    const { logged, store } = modules.context;
    const { checkSchedules, SCHEDULE_TICK_MS } = modules.jobs;
    const { sendEmails } = modules.mail;
    const { deliverWebhooks } = modules.webhooks;
    const { SNAPSHOT_TIDY_MS, tidyAllSnapshots } = modules.snapshots;
    const { sweepSessions } = modules.auth;
    const tidy = () => { tidyAllSnapshots().catch(logged('camera', 'Snapshot clean-up failed')); };
    checkSchedules();
    sendEmails();
    deliverWebhooks();
    tidy();
    this.timers = [
      setInterval(checkSchedules, SCHEDULE_TICK_MS),
      setInterval(sweepSessions, 60000),
      setInterval(sendEmails, 30000),
      setInterval(deliverWebhooks, 30000),
      setInterval(() => {
        dk.deleteExpiredTokens(store).catch(logged('session', 'Expired link clean-up failed'));
        dk.pruneLoginAudit(store).catch(logged('session', 'Login audit clean-up failed'));
      }, 3600000),
      setInterval(tidy, SNAPSHOT_TIDY_MS),
    ];
  }
}
