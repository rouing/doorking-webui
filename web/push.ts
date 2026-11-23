/**
 * @module web/push
 *
 * Web Push delivery module: initializes/caches VAPID keys on start and sends alerts to subscribed devices.
 */
import * as dk from '../index.ts';
import type { ContextModule } from './context.ts';
import { logger, logMessages } from '../src/logging.ts';

/**
 * Creates the server's Web Push module.
 *
 * @param deps - Shared server context.
 * @returns VAPID key loader, gate-admin push alert sender, and user test push helper.
 */
export function createPush(deps: ContextModule) {
  const { APP, config, store } = deps;
  let vapidPromise: Promise<dk.VapidConfig> | null = null;

  /** Loads or auto-generates the server's VAPID keypair (cached for this server instance). */
  function vapid(): Promise<dk.VapidConfig> {
    if (!vapidPromise) {
      vapidPromise = dk.ensureVapidKeys(store, { ...config.push, appUrl: APP }).catch((err) => {
        vapidPromise = null;
        throw err;
      });
    }
    return vapidPromise;
  }

  /** Returns the public VAPID key (base64url) browsers pass to `pushManager.subscribe`. */
  async function publicKey(): Promise<string> {
    return (await vapid()).publicKey;
  }

  /**
   * Sends a Web Push notification to all gate admins of `phone` who have `notify_alerts` enabled.
   * Never throws (errors are logged).
   *
   * @param phone - Gate system phone number.
   * @param title - Notification title.
   * @param body - Notification body text.
   */
  async function pushGateAlert(phone: string, title: string, body: string): Promise<void> {
    try {
      const admins = await dk.pushAlertRecipients(store, phone);
      if (!admins.length) return;
      await dk.sendPushToUsers(store, await vapid(), admins, { title, body, url: '/', tag: `gate-${dk.phoneDigits(phone)}` }, { log: logMessages('server') });
    } catch (err) {
      logger('server').warn`Web Push gate alert failed: ${(err as Error).message}`;
    }
  }

  /**
   * Sends a test push notification to all of `username`'s subscribed devices.
   *
   * @param username - Local account username.
   * @returns Promise resolving to `{ sent, failed, removed }`.
   */
  async function sendTestPush(username: string): Promise<{ sent: number; failed: number; removed: number }> {
    return dk.sendPushToUsers(store, await vapid(), [username], {
      title: 'DoorKing Gate Manager',
      body: 'Push notifications are working on this device.',
      url: '/',
      tag: 'doorking-test',
    }, { log: logMessages('server') });
  }

  /**
   * Sends a Web Push notification to one user's subscribed devices (never throws).
   *
   * @param username - Local account username.
   * @param title - Notification title.
   * @param body - Notification body text (never include secret gate codes).
   * @param [tag] - Notification tag for collapsing duplicates.
   */
  async function pushUserNotice(username: string, title: string, body: string, tag = 'doorking-notice'): Promise<void> {
    try {
      await dk.sendPushToUsers(store, await vapid(), [username], { title, body, url: '/', tag }, { log: logMessages('server') });
    } catch (err) {
      logger('server').warn`Web Push user notice failed: ${(err as Error).message}`;
    }
  }

  return { publicKey, pushGateAlert, pushUserNotice, sendTestPush };
}

export type PushModule = ReturnType<typeof createPush>;
