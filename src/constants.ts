import type { LargeFileUploadMessages } from './types';

// 默认分片大小（8MB），适合大多数网络环境
export const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;
// 默认并发分片数量
export const DEFAULT_CHUNK_CONCURRENCY = 4;
// 默认重试次数
export const DEFAULT_RETRY_TIMES = 3;
// 退避重试：基础等待时间（毫秒）
export const DEFAULT_RETRY_BASE_DELAY_MS = 300;
// 退避重试：最大等待时间（毫秒）
export const DEFAULT_RETRY_MAX_DELAY_MS = 5_000;
// 退避重试：抖动比例（避免所有请求同时重试）
export const DEFAULT_RETRY_JITTER_RATIO = 0.2;
// 本地缓存任务的最大数量
export const DEFAULT_TASK_CACHE_LIMIT = 16;
// 分片进度刷新间隔（毫秒）
export const CHUNK_PROGRESS_FLUSH_INTERVAL_MS = 120;
// 进度回调最小时间间隔（毫秒）
export const DEFAULT_PROGRESS_INTERVAL_MS = 200;
// 进度回调最小变化百分比（0-100）
export const DEFAULT_PROGRESS_DELTA_PERCENT = 1;
// 指纹采样的字节数（用于 hash 采样）
export const FINGERPRINT_SAMPLE_BYTES = 1024 * 1024;
// 标记“等待重新选择文件”的错误码
export const WAITING_FILE_ERROR = 'WAITING_FILE';
// 标记“离线暂停”的错误码
export const OFFLINE_ERROR = 'UPLOAD_OFFLINE';
// 默认 storage key
export const DEFAULT_STORAGE_KEY = 'large-file-upload:tasks:v1';

// 默认文案（可由用户覆盖）
export const DEFAULT_MESSAGES: Required<LargeFileUploadMessages> = {
  waitingFile: 'Please reselect the same file to resume upload.',
  offlinePause: 'Network disconnected, upload paused.',
  manualPause: 'Upload paused.',
  uploadFailed: 'Upload failed, please retry.',
  restoredWaitingFile: 'Upload progress restored, please reselect the same file to continue.',
  missingUrl: 'Upload succeeded but returned URL is missing.',
};
