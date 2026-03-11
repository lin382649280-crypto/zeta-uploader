import type { StorageAdapter } from '../types';

// 浏览器 localStorage 的默认适配器
export const createBrowserStorage = (): StorageAdapter | null => {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  return {
    // 读取（失败则返回 null）
    get: (key) => {
      try {
        const raw = window.localStorage.getItem(key);
        return raw ? (JSON.parse(raw) as unknown) : null;
      } catch {
        return null;
      }
    },
    // 写入（失败则忽略）
    set: (key, value) => {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
      } catch {
        // ignore write errors
      }
    },
    // 删除（失败则忽略）
    remove: (key) => {
      try {
        window.localStorage.removeItem(key);
      } catch {
        // ignore removal errors
      }
    },
  };
};
