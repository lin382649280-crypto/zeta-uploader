import type { LargeFileUploadTask } from '../types';
import { toInt } from './number';

// 规范化服务端返回的分片索引数组
// - 去重
// - 过滤非法值
// - 排序
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

// 计算某个分片的字节大小（最后一片可能不足 chunkSize）
export const resolveChunkByteSize = (task: LargeFileUploadTask, chunkIndex: number) => {
  if (chunkIndex < 0 || chunkIndex >= task.totalChunks) return 0;
  if (chunkIndex === task.totalChunks - 1) {
    const remaining = task.fileSize - task.chunkSize * (task.totalChunks - 1);
    return Math.max(0, remaining);
  }
  return Math.max(0, task.chunkSize);
};
