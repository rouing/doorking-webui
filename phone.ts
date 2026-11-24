/**
 * @module web/ui/phone
 *
 * The phone layout: narrow windows, and phones turned sideways (short, with a touch screen). styles.css uses the same
 * query.
 */
import { useSyncExternalStore } from 'react';

export const PHONE = '(max-width: 760px), (max-height: 500px) and (pointer: coarse)';
export const phoneQuery = window.matchMedia(PHONE);

/**
 * True while the window uses the phone layout.
 *
 * @returns True when the condition holds.
 */
export function usePhone(): boolean {
  return useSyncExternalStore((onChange) => {
    phoneQuery.addEventListener('change', onChange);
    return () => phoneQuery.removeEventListener('change', onChange);
  }, () => phoneQuery.matches);
}
