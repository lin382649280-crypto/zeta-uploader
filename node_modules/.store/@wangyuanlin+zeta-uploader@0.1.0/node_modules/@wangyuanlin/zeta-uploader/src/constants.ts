import type { LargeFileUploadMessages } from './types';

export const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;
export const DEFAULT_CHUNK_CONCURRENCY = 4;
export const DEFAULT_RETRY_TIMES = 3;
export const DEFAULT_TASK_CACHE_LIMIT = 16;
export const CHUNK_PROGRESS_FLUSH_INTERVAL_MS = 120;
export const FINGERPRINT_SAMPLE_BYTES = 1024 * 1024;
export const WAITING_FILE_ERROR = 'WAITING_FILE';
export const OFFLINE_ERROR = 'UPLOAD_OFFLINE';
export const DEFAULT_STORAGE_KEY = 'large-file-upload:tasks:v1';

export const DEFAULT_MESSAGES: Required<LargeFileUploadMessages> = {
  waitingFile: 'Please reselect the same file to resume upload.',
  offlinePause: 'Network disconnected, upload paused.',
  uploadFailed: 'Upload failed, please retry.',
  restoredWaitingFile: 'Upload progress restored, please reselect the same file to continue.',
  missingUrl: 'Upload succeeded but returned URL is missing.',
};
