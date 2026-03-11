import type { LargeFileUploadTask } from '../types';
import { resolveChunkByteSize } from './chunk';

// 计算任务已上传的字节数（已完成分片 + 正在上传分片）
export const resolveTaskUploadedBytes = (
  task: LargeFileUploadTask,
  chunkLoadedBytesMap: Record<string, number>,
) => {
  const uploadedSet = new Set<number>(task.uploadedChunkIndexes || []);
  let bytes = 0;
  // 已完成的分片直接累加
  uploadedSet.forEach((chunkIndex) => {
    bytes += resolveChunkByteSize(task, chunkIndex);
  });
  // 正在上传的分片根据实时 loaded 计算
  const prefix = `${task.uploadId}:`;
  Object.entries(chunkLoadedBytesMap).forEach(([key, loaded]) => {
    if (!key.startsWith(prefix)) return;
    const chunkIndex = Number(key.slice(prefix.length));
    if (!Number.isFinite(chunkIndex) || uploadedSet.has(chunkIndex)) return;
    bytes += Math.min(Math.max(0, Number(loaded || 0)), resolveChunkByteSize(task, chunkIndex));
  });
  return Math.min(Math.max(0, task.fileSize), Math.max(0, bytes));
};

// 计算任务进度百分比
export const resolveTaskProgressPercent = (
  task: LargeFileUploadTask,
  chunkLoadedBytesMap: Record<string, number>,
) => {
  const total = Math.max(1, Number(task.fileSize || 0));
  return Math.min(100, Math.floor((resolveTaskUploadedBytes(task, chunkLoadedBytesMap) / total) * 100));
};

// 计算所有任务整体进度百分比
export const resolveOverallProgress = (
  tasks: LargeFileUploadTask[],
  chunkLoadedBytesMap: Record<string, number>,
) => {
  if (!tasks.length) return 0;
  const totalBytes = tasks.reduce((sum, task) => sum + Math.max(0, Number(task.fileSize || 0)), 0);
  if (!totalBytes) return 0;
  const uploadedBytes = tasks.reduce((sum, task) => sum + resolveTaskUploadedBytes(task, chunkLoadedBytesMap), 0);
  return Math.min(100, Math.floor((uploadedBytes / totalBytes) * 100));
};
