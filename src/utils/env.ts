import { DEFAULT_CHUNK_CONCURRENCY } from '../constants';

export const resolvePreferredChunkConcurrency = () => {
  if (typeof navigator === 'undefined') return DEFAULT_CHUNK_CONCURRENCY;
  const cores = Math.max(1, Number(navigator.hardwareConcurrency || 4));
  if (cores <= 4) return 2;
  if (cores <= 8) return 3;
  return DEFAULT_CHUNK_CONCURRENCY;
};

export const resolveDefaultIsOnline = () => (typeof navigator === 'undefined' ? true : navigator.onLine);
