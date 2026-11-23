/**
 * @module web/modules
 *
 * Builds the server's modules from its services, each given only what it uses (dependencies flow one way:
 * context <- auth, mail, editing <- snapshots <- jobs <- routes).
 */
import { createAuth } from './auth.ts';
import { createContext, type Services } from './context.ts';
import { createEditing } from './editing.ts';
import { createJobs } from './jobs.ts';
import { createMail } from './mail.ts';
import { createPush } from './push.ts';
import { createSnapshots } from './snapshots.ts';
import { createWebhooks } from './webhooks.ts';
import { accountRoutes } from './routes/account.ts';
import { authRoutes } from './routes/auth.ts';
import { camerasRoutes } from './routes/cameras.ts';
import { connectionsRoutes } from './routes/connections.ts';
import { docsRoutes } from './routes/docs.ts';
import { gatesRoutes } from './routes/gates.ts';
import { portalRoutes } from './routes/portal.ts';
import { relaysRoutes } from './routes/relays.ts';
import { residentsRoutes } from './routes/residents.ts';
import { schedulesRoutes } from './routes/schedules.ts';
import { webhooksRoutes } from './routes/webhooks.ts';
import { workingCopyRoutes } from './routes/working-copy.ts';
import type { Route } from './routing.ts';

/**
 * Create modules.
 *
 * @param services - Core server services (`config`, `store`, `cameras`, `mailer`).
 * @returns Operation result.
 */
export function createModules(services: Services) {
  const context = createContext(services);
  const auth = createAuth(context);
  const push = createPush(context);
  const mail = createMail({ ...context, ...push });
  const webhooks = createWebhooks(context);
  const editing = createEditing(context);
  const snapshots = createSnapshots({ ...context, ...editing });
  const jobs = createJobs({ ...context, ...editing, ...mail, ...snapshots, ...webhooks });
  return { context, auth, push, mail, webhooks, editing, snapshots, jobs };
}

export type Modules = ReturnType<typeof createModules>;

/**
 * Every route, in matching order (the first match wins).
 *
 * @param modules - Composed server modules (`context`, `auth`, `mail`, `editing`, `snapshots`, `jobs`).
 * @returns Registered route definitions for this area.
 */
export function createRoutes(modules: Modules): Route[] {
  return [
    ...docsRoutes(modules),
    ...authRoutes(modules),
    ...accountRoutes(modules),
    ...portalRoutes(modules),
    ...gatesRoutes(modules),
    ...connectionsRoutes(modules),
    ...residentsRoutes(modules),
    ...workingCopyRoutes(modules),
    ...relaysRoutes(modules),
    ...schedulesRoutes(modules),
    ...webhooksRoutes(modules),
    ...camerasRoutes(modules),
  ];
}
