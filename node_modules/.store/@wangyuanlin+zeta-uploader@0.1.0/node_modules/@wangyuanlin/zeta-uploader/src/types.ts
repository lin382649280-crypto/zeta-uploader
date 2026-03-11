export type LargeFileTaskStatus = 'uploading' | 'paused' | 'failed' | 'waiting_file';

export interface LargeFileUploadTask {
  uploadId: string;
  fingerprint: string;
  fileName: string;
  fileSize: number;
  chunkSize: number;
  totalChunks: number;
  uploadedChunkIndexes: number[];
  progress?: number;
  status: LargeFileTaskStatus;
  errorMessage: string;
  updatedAt: number;
}

export interface LargeFileUploadState {
  tasks: LargeFileUploadTask[];
  chunkLoadedBytesMap: Record<string, number>;
}

export interface LargeFileUploadResult {
  url: string;
  taskHandled: boolean;
}

export interface ChunkUploadInitPayload {
  fileHash: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  chunkSize: number;
  totalChunks: number;
}

export interface ChunkUploadChunkPayload {
  uploadId: string;
  chunkIndex: number;
  totalChunks: number;
  chunk: Blob;
}

export interface UploadedFileInfo {
  url?: string;
  savedName?: string;
}

export interface ChunkUploadInitResult {
  uploadId?: string;
  uploadedChunks?: number[];
  totalChunks?: number;
  chunkSize?: number;
  completed?: boolean;
  fileInfo?: UploadedFileInfo | null;
}

export type ChunkUploadStatusResult = ChunkUploadInitResult;

export interface ChunkUploadCompleteResult {
  fileInfo?: UploadedFileInfo | null;
  files?: UploadedFileInfo[] | null;
}

export interface UploadChunkOptions {
  signal?: AbortSignal;
  onProgress?: (loadedBytes: number, totalBytes: number) => void;
}

export interface ChunkUploadStatusOptions {
  skipDedupe?: boolean;
}

export interface ChunkUploadApi<
  InitResponse = unknown,
  StatusResponse = unknown,
  CompleteResponse = unknown,
> {
  init: (payload: ChunkUploadInitPayload) => Promise<InitResponse>;
  status: (uploadId: string, options?: ChunkUploadStatusOptions) => Promise<StatusResponse>;
  uploadChunk: (payload: ChunkUploadChunkPayload, options?: UploadChunkOptions) => Promise<unknown>;
  complete: (uploadId: string) => Promise<CompleteResponse>;
}

export interface StorageAdapter {
  get: <T = unknown>(key: string) => T | null | undefined;
  set: (key: string, value: unknown) => void;
  remove: (key: string) => void;
}

export interface LargeFileUploadMessages {
  waitingFile?: string;
  offlinePause?: string;
  uploadFailed?: string;
  restoredWaitingFile?: string;
  missingUrl?: string;
}

export interface LargeFileUploadOptions<
  InitResponse = unknown,
  StatusResponse = unknown,
  CompleteResponse = unknown,
> {
  api: ChunkUploadApi<InitResponse, StatusResponse, CompleteResponse>;
  resolveInitResponse?: (response: InitResponse) => ChunkUploadInitResult;
  resolveStatusResponse?: (response: StatusResponse) => ChunkUploadStatusResult;
  resolveCompleteResponse?: (response: CompleteResponse) => ChunkUploadCompleteResult;
  resolveUploadedUrl: (fileInfo?: UploadedFileInfo | null, fallbackUrl?: unknown) => string;
  buildFingerprint?: (file: File) => Promise<string> | string;
  storage?: StorageAdapter;
  storageKey?: string;
  taskCacheLimit?: number;
  chunkSize?: number;
  retryTimes?: number;
  chunkConcurrency?: number | ((file: File) => number);
  isOnline?: () => boolean;
  messages?: LargeFileUploadMessages;
  onTaskComplete?: (task: LargeFileUploadTask, url: string, file: File | null) => void;
}

export interface LargeFileUploadManager {
  getState: () => LargeFileUploadState;
  subscribe: (listener: (state: LargeFileUploadState) => void) => () => void;
  upload: (file: File) => Promise<LargeFileUploadResult>;
  resume: (uploadId: string) => Promise<boolean>;
  remove: (uploadId: string) => void;
  pauseAll: () => void;
  resumePaused: () => void;
  dispose: () => void;
  getTaskById: (uploadId: string) => LargeFileUploadTask | undefined;
  getTaskByFingerprint: (fingerprint: string) => LargeFileUploadTask | undefined;
}
