/**
 * @module web/mail
 *
 * Account emails and gate alerts, sent through the outbox (src/email.ts).
 */
import * as dk from '../index.ts';
import type { ContextModule } from './context.ts';
import type { PushModule } from './push.ts';
import { logger, logMessages } from '../src/logging.ts';

/**
 * Create mail.
 *
 * @param deps - Injected module dependencies.
 * @returns Operation result.
 */
export function createMail(deps: ContextModule & Partial<Pick<PushModule, 'pushGateAlert' | 'pushUserNotice'>>) {
  const { APP, config, mailer, pushGateAlert, pushUserNotice, siteNameOf, store } = deps;
  let sending: Promise<unknown> | null = null;
  function sendEmails(): void {
    if (!mailer || sending) return;
    sending = dk.sendQueued(store, mailer, config.email.from, logMessages('email'))
      .catch((err) => logger('email').error`Outbox failed: ${(err as Error).message}`)
      .finally(() => { sending = null; });
  }
  /**
   * Queues a message to an address (nothing when email is off). A failure to queue is written to the server log.
   *
   * @param to - Recipient email address.
   * @param msg - Error or email message.
   * @param kind - Item or operation kind.
   */
  async function mailTo(to: string, msg: { subject: string; text: string }, kind: string): Promise<void> {
    await mailOrFail(to, msg, kind).catch(() => {});
  }
  /**
   * The same, but a failure to queue is also thrown (502): for links the user is told were sent (invitations, email
   * confirmations).
   *
   * @param to - Recipient email address.
   * @param msg - Error or email message.
   * @param kind - Item or operation kind.
   * @throws HTTP 502 error on invalid input or conflict.
   */
  async function mailOrFail(to: string, msg: { subject: string; text: string }, kind: string): Promise<void> {
    if (!mailer || !to) return;
    try { await dk.queueEmail(store, { to, ...msg, kind }); sendEmails(); } catch (err) {
      const why = (err as Error).message;
      logger('email').warn`Not queued (${kind}): ${why}`;
      throw dk.httpError(`The email couldn't be sent (${why}). Try again later.`, 502);
    }
  }
  /**
   * A security alert to the user's confirmed email (always sent; it can't be turned off).
   *
   * @param username - Local account username.
   * @param what - Transfer kind (`residents`, `transactions`, `send`, or `snapshots`).
   */
  async function securityAlert(username: string, what: string): Promise<void> {
    const user = await dk.getUser(store, username);
    if (user && user.email) await mailTo(user.email, dk.messages.security(APP, user.username, what), 'security');
  }
  /**
   * A gate-access email to the user (only to a confirmed email, and only if they haven't turned these off).
   *
   * @param username - Local account username.
   * @param msg - Error or email message.
   */
  async function accessEmail(username: string, msg: (user: dk.User) => { subject: string; text: string }): Promise<void> {
    const user = await dk.getUser(store, username);
    if (user && user.email && user.notifyAccess) await mailTo(user.email, msg(user), 'access');
  }
  const gateName = async (phone: string) => (await siteNameOf(phone)) || `the gate ${phone}`;
  /**
   * A gate alert to the gate's admins who have alerts on.
   *
   * @param phone - Gate system phone number (digits or formatted).
   * @param what - Transfer kind (`residents`, `transactions`, `send`, or `snapshots`).
   * @param detail - `string` value.
   */
  async function gateAlert(phone: string, what: string, detail: string): Promise<void> {
    const name = await gateName(phone);
    if (mailer) {
      for (const recipient of await dk.alertRecipients(store, phone)) await mailTo(recipient.email, dk.messages.gateAlert(APP, recipient.username, name, what, detail), 'alert');
    }
    if (pushGateAlert) {
      await pushGateAlert(phone, `${name}: ${what}`, detail);
    }
  }
  /**
   * Sends a new invitation link to the invited user's email (from `by`, for gate `phone`).
   *
   * @param username - Local account username.
   * @param by - Username of the user performing the action.
   * @param phone - Gate system phone number (digits or formatted).
   */
  async function sendInvite(username: string, by: string, phone: string): Promise<void> {
    const user = await dk.getUser(store, username);
    if (!user || !user.pendingEmail) return;
    const token = await dk.createToken(store, 'invite', user.username, user.pendingEmail);
    await mailOrFail(user.pendingEmail, dk.messages.invite(APP, user.username, by, await gateName(phone), token), 'invite');
  }
  /**
   * Sends a tailored Resident Portal invitation link explaining email sign-in and iOS/Android PWA install steps.
   *
   * @param username - Newly created resident username.
   * @param phone - Gate system phone number.
   * @param directoryCode - Resident directory code.
   */
  async function sendResidentInvite(username: string, phone: string, directoryCode: string): Promise<void> {
    const user = await dk.getUser(store, username);
    if (!user || !user.pendingEmail) return;
    const token = await dk.createToken(store, 'invite', user.username, user.pendingEmail);
    await mailOrFail(user.pendingEmail, dk.messages.residentInvite(APP, user.pendingEmail, await gateName(phone), directoryCode, token), 'invite');
  }
  /**
   * Sends the confirmation link for the user's pending email.
   *
   * @param username - Local account username.
   */
  async function sendVerification(username: string): Promise<void> {
    const user = await dk.getUser(store, username);
    if (!user || !user.pendingEmail || !mailer) return;
    await mailOrFail(user.pendingEmail, dk.messages.verify(APP, user.username, await dk.createToken(store, 'verify', user.username, user.pendingEmail)), 'verify');
  }
  /**
   * Notifies a resident with an enabled portal account when their gate entry code changes (Push never includes the
   * raw 4-digit code; directs them to open the app).
   *
   * @param phone - Gate system phone number.
   * @param directoryCode - Resident directory code.
   * @param options - Whether the code is already live on the gate or waiting for a Send.
   */
  async function notifyResidentCodeChanged(
    phone: string,
    directoryCode: string,
    { synced, nextScheduledSend }: { synced: boolean; nextScheduledSend?: string | null },
  ): Promise<void> {
    const target = await dk.residentNotifyTarget(store, phone, directoryCode);
    if (!target) return;
    const name = await gateName(phone);
    const timing = synced
      ? 'Your new gate entry code is now active on the gate. Open the app to view it.'
      : nextScheduledSend
        ? `Your new gate entry code is queued and will be sent to the gate automatically around ${new Date(nextScheduledSend).toLocaleString('en-US')}. Open the app to view it.`
        : 'Your new gate entry code has been saved and will take effect after an administrator sends changes to the gate. Open the app to view it.';
    if (pushUserNotice) {
      await pushUserNotice(target.username, `${name}: Gate code updated`, timing, `code-${dk.phoneDigits(phone)}-${directoryCode}`);
    }
    if (mailer && target.email) {
      await mailTo(target.email, {
        subject: `${name}: Your gate entry code was updated`,
        text: `Hi ${target.username},\n\n${timing}\n\nOpen DoorKing Gate Manager: ${APP || '/'}\n`,
      }, 'access');
    }
  }

  /**
   * Notifies an existing user that they were bound to a Resident Portal unit (no re-signup needed).
   *
   * @param username - Existing user's username.
   * @param phone - Gate system phone number.
   * @param directoryCode - Unit directory code.
   */
  async function sendPortalBoundEmail(username: string, phone: string, directoryCode: string): Promise<void> {
    const user = await dk.getUser(store, username);
    if (!user || !user.email || !mailer) return;
    const name = await gateName(phone);
    await mailTo(user.email, {
      subject: `${name}: Resident Portal access enabled`,
      text: `Hi ${user.username},\n\nResident Portal access for ${name} (Directory Code ${directoryCode}) has been linked to your existing account. Sign in with your existing password or passkey at ${APP || '/'}.\n`,
    }, 'access');
  }

  /**
   * Notifies a resident when an administrator approves or rejects their change request.
   *
   * @param username - Resident username.
   * @param phone - Gate system phone number.
   * @param decision - `'approved'` or `'rejected'`.
   * @param summary - Short description of the request.
   * @param reviewNote - Optional admin note.
   */
  async function notifyResidentRequestReviewed(
    username: string,
    phone: string,
    decision: 'approved' | 'rejected',
    summary: string,
    reviewNote = '',
  ): Promise<void> {
    const name = await gateName(phone);
    const body = `Your request (${summary}) was ${decision}.${reviewNote ? ` Note: ${reviewNote}` : ''}`;
    if (pushUserNotice) await pushUserNotice(username, `${name}: Request ${decision}`, body, `req-${dk.phoneDigits(phone)}`);
    const user = await dk.getUser(store, username);
    if (mailer && user?.email) {
      await mailTo(user.email, { subject: `${name}: Request ${decision}`, text: `Hi ${user.username},\n\n${body}\n\n${APP || '/'}\n` }, 'access');
    }
  }

  /**
   * Resolves when no email is being sent (waited for on shutdown, so an email the mail server took is marked sent).
   *
   * @returns Computed result.
   */
  const mailIdle = () => sending ?? Promise.resolve();
  return {
    mailIdle, sendEmails, mailTo, securityAlert, accessEmail, gateName, gateAlert, sendInvite, sendResidentInvite, sendVerification,
    notifyResidentCodeChanged, sendPortalBoundEmail, notifyResidentRequestReviewed,
  };
}

export type MailModule = ReturnType<typeof createMail>;
