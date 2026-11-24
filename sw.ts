/**
 * @module web/ui/sw
 *
 * Service worker for the DoorKing Gate Manager PWA: precaches static assets via Workbox, handles prompt-to-reload
 * updates (`SKIP_WAITING`), and renders incoming Web Push alerts with click-to-focus navigation.
 */
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

interface SwClient {
  url: string;
  focus(): Promise<SwClient>;
}

interface SwRegistration {
  showNotification(title: string, options?: NotificationOptions): Promise<void>;
}

interface SwPushEvent extends Event {
  data?: { json(): unknown; text(): string } | null;
  waitUntil(promise: Promise<unknown>): void;
}

interface SwNotificationEvent extends Event {
  notification: Notification & { data?: { url?: string } };
  waitUntil(promise: Promise<unknown>): void;
}

interface SwScope {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
  registration: SwRegistration;
  location: Location;
  clients: {
    matchAll(options?: { type?: string; includeUncontrolled?: boolean }): Promise<SwClient[]>;
    openWindow(url: string): Promise<SwClient | null>;
  };
  skipWaiting(): Promise<void>;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  addEventListener(type: 'push', listener: (event: SwPushEvent) => void): void;
  addEventListener(type: 'notificationclick', listener: (event: SwNotificationEvent) => void): void;
}

const sw = self as unknown as SwScope;
const manifest = (self as unknown as { __WB_MANIFEST: SwScope['__WB_MANIFEST'] }).__WB_MANIFEST;

cleanupOutdatedCaches();
precacheAndRoute(manifest);
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html'), {
  denylist: [/^\/api\//, /^\/help(?:\/|$)/, /^\/privacy(?:\/|$)/, /^\/download(?:\/|$)/, /^\/\.well-known\//],
}));

sw.addEventListener('message', (event) => {
  if (event.data && (event.data as { type?: string }).type === 'SKIP_WAITING') {
    void sw.skipWaiting();
  }
});

sw.addEventListener('push', (event) => {
  let payload: { title?: string; body?: string; url?: string; tag?: string } = {};
  if (event.data) {
    try {
      payload = event.data.json() as typeof payload;
    } catch {
      payload = { body: event.data.text() };
    }
  }
  const title = payload.title || 'DoorKing Gate Manager';
  const body = payload.body || 'Gate alert';
  const url = payload.url || '/';
  event.waitUntil(sw.registration.showNotification(title, {
    body,
    icon: '/pwa-192x192.png',
    badge: '/pwa-64x64.png',
    tag: payload.tag || 'doorking-alert',
    data: { url },
  }));
});

sw.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', sw.location.origin).href;
  event.waitUntil((async () => {
    const windows = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const win of windows) {
      if (win.url.startsWith(sw.location.origin)) {
        await win.focus();
        return;
      }
    }
    await sw.clients.openWindow(target);
  })());
});
