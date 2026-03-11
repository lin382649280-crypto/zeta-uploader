import { DEFAULT_CHUNK_CONCURRENCY } from '../constants';

// 根据 CPU 核心数估算一个合理的默认并发
export const resolvePreferredChunkConcurrency = () => {
  if (typeof navigator === 'undefined') return DEFAULT_CHUNK_CONCURRENCY;
  const cores = Math.max(1, Number(navigator.hardwareConcurrency || 4));
  if (cores <= 4) return 2;
  if (cores <= 8) return 3;
  return DEFAULT_CHUNK_CONCURRENCY;
};

// 默认在线判断（浏览器环境才有 navigator.onLine）
export const resolveDefaultIsOnline = () => (typeof navigator === 'undefined' ? true : navigator.onLine);
