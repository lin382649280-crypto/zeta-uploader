import type { LargeFileUploadTask } from '../types';
import { toInt } from './number';

export const normalizeChunkIndexes = (raw: unknown, totalChunks: number) => {
  if (!Array.isArray(raw)) return [];
  return Array.from(
    new Set(
      raw
        .map((item) => toInt(item, -1))
        .filter((index) => index >= 0 && index < totalChunks)
        .sort((a, b) => a - b),
    ),
  );
};

export const resolveChunkByteSize = (task: LargeFileUploadTask, chunkIndex: number) => {
  if (chunkIndex < 0 || chunkIndex >= task.totalChunks) return 0;
  if (chunkIndex === task.totalChunks - 1) {
    const remaining = task.fileSize - task.chunkSize * (task.totalChunks - 1);
    return Math.max(0, remaining);
  }
  return Math.max(0, task.chunkSize);
};
