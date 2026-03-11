import type { StorageAdapter } from '../types';

export const createBrowserStorage = (): StorageAdapter | null => {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  return {
    get: (key) => {
      try {
        const raw = window.localStorage.getItem(key);
        return raw ? (JSON.parse(raw) as unknown) : null;
      } catch {
        return null;
      }
    },
    set: (key, value) => {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
      } catch {
        // ignore write errors
      }
    },
    remove: (key) => {
      try {
        window.localStorage.removeItem(key);
      } catch {
        // ignore removal errors
      }
    },
  };
};
