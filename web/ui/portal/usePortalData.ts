/**
 * @module web/ui/portal/usePortalData
 *
 * State, offline cache (excluding sensitive `entryCode`), and adaptive live status polling for the Resident Portal.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PortalActivityReply, PortalMeReply, PortalStatusReply, ResidentRequest } from '../../../src/types.ts';
import { ApiError, api, errorText, lsGet, lsSet } from '../api.ts';

export const portalUrl = (phone: string, suffix: string) => `/api/portal/gates/${encodeURIComponent(phone)}${suffix}`;

const PORTAL_CACHE_PREFIX = 'dk-portal-cache-';

/** Removes all Resident Portal offline cache entries from browser storage (called on sign-out). */
export function clearPortalCache(): void {
  if (typeof window === 'undefined') return;
  try {
    for (let i = window.localStorage.length - 1; i >= 0; i--) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith(PORTAL_CACHE_PREFIX)) window.localStorage.removeItem(key);
    }
  } catch { /* ignore storage restrictions */ }
}

function sanitizeForOfflineCache(reply: PortalMeReply): PortalMeReply {
  return { ...reply, unit: { ...reply.unit, entryCode: '' } };
}

interface UsePortalDataOptions {
  gatePhone: string;
  username: string;
  activeTab: 'gate' | 'activity' | 'requests' | 'account';
  selectedCode: string;
  onSelectCode: (code: string) => void;
  fastPollRequested: boolean;
  onError: (msg: string) => void;
}

export function usePortalData({
  gatePhone, username, activeTab, selectedCode, onSelectCode, fastPollRequested, onError,
}: UsePortalDataOptions) {
  const cacheKey = `${PORTAL_CACHE_PREFIX}${username}-${gatePhone}`;
  const codeQuery = selectedCode ? `?code=${encodeURIComponent(selectedCode)}` : '';

  const [me, setMe] = useState<PortalMeReply | null>(null);
  const meRef = useRef<PortalMeReply | null>(null);
  meRef.current = me;
  const [loadingMe, setLoadingMe] = useState(true);
  const [offline, setOffline] = useState(() => (typeof navigator !== 'undefined' ? !navigator.onLine : false));
  const [status, setStatus] = useState<PortalStatusReply | null>(null);
  const [activity, setActivity] = useState<PortalActivityReply | null>(null);
  const [loadingActivity, setLoadingActivity] = useState(false);
  const [requests, setRequests] = useState<ResidentRequest[]>([]);
  const [loadingRequests, setLoadingRequests] = useState(false);

  const loadMe = useCallback(async () => {
    setLoadingMe((prev) => prev || !meRef.current);
    try {
      const reply = await api<PortalMeReply>('GET', portalUrl(gatePhone, `/me${codeQuery}`));
      setMe(reply);
      lsSet(cacheKey, sanitizeForOfflineCache(reply));
      setOffline(false);
      if (!codeQuery && reply.unit.directoryCode) onSelectCode(reply.unit.directoryCode);
      onError('');
    } catch (err) {
      const cached = lsGet<PortalMeReply | null>(cacheKey, null);
      if (!(err instanceof ApiError) && (meRef.current || cached)) {
        if (!meRef.current && cached) {
          setMe(cached);
          if (!codeQuery && cached.unit.directoryCode) onSelectCode(cached.unit.directoryCode);
        }
        setOffline(true);
        onError('');
      } else {
        onError(errorText(err));
      }
    } finally {
      setLoadingMe(false);
    }
  }, [gatePhone, cacheKey, codeQuery, onSelectCode, onError]);

  const loadStatus = useCallback(async () => {
    try {
      const reply = await api<PortalStatusReply>('GET', portalUrl(gatePhone, '/status'));
      setStatus(reply);
      setOffline(false);
    } catch (err) {
      if (!(err instanceof ApiError) && typeof navigator !== 'undefined' && !navigator.onLine) {
        setOffline(true);
      }
    }
  }, [gatePhone]);

  const loadActivity = useCallback(async () => {
    setLoadingActivity(true);
    try {
      const act = await api<PortalActivityReply>('GET', portalUrl(gatePhone, `/activity${codeQuery}`));
      setActivity(act);
      setOffline(false);
    } catch (err) {
      if (!(err instanceof ApiError) && typeof navigator !== 'undefined' && !navigator.onLine) {
        setOffline(true);
      } else {
        onError(errorText(err));
      }
    } finally {
      setLoadingActivity(false);
    }
  }, [gatePhone, codeQuery, onError]);

  const loadRequests = useCallback(async () => {
    setLoadingRequests(true);
    try {
      const reply = await api<{ requests: ResidentRequest[] }>('GET', portalUrl(gatePhone, '/requests'));
      setRequests(reply.requests);
      setOffline(false);
    } catch (err) {
      if (!(err instanceof ApiError) && typeof navigator !== 'undefined' && !navigator.onLine) {
        setOffline(true);
      } else {
        onError(errorText(err));
      }
    } finally {
      setLoadingRequests(false);
    }
  }, [gatePhone, onError]);

  useEffect(() => {
    void loadMe();
    void loadStatus();
  }, [loadMe, loadStatus]);

  useEffect(() => {
    const onOnline = () => { setOffline(false); void loadMe(); void loadStatus(); };
    const onOffline = () => setOffline(true);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [loadMe, loadStatus]);

  useEffect(() => {
    if (activeTab === 'activity') void loadActivity();
    if (activeTab === 'requests') void loadRequests();
  }, [activeTab, loadActivity, loadRequests]);

  useEffect(() => {
    const needsFastPoll = Boolean((status && (!status.available || status.cooldownSeconds > 0)) || fastPollRequested);
    const id = window.setInterval(() => {
      void loadStatus();
      if (status && !status.available) void loadMe();
    }, needsFastPoll ? 2000 : 15000);
    return () => window.clearInterval(id);
  }, [status, fastPollRequested, loadStatus, loadMe]);

  return {
    me, loadingMe, offline, status, activity, loadingActivity, requests, loadingRequests,
    loadMe, loadStatus, loadActivity, loadRequests,
  };
}
