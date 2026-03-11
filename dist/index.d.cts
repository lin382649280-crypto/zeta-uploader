type LargeFileTaskStatus = 'uploading' | 'paused' | 'failed' | 'waiting_file';
interface LargeFileUploadTask {
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
interface LargeFileUploadState {
    tasks: LargeFileUploadTask[];
    chunkLoadedBytesMap: Record<string, number>;
}
interface LargeFileUploadResult {
    url: string;
    taskHandled: boolean;
}
interface ChunkUploadInitPayload {
    fileHash: string;
    fileName: string;
    fileSize: number;
    mimeType: string;
    chunkSize: number;
    totalChunks: number;
}
interface ChunkUploadChunkPayload {
    uploadId: string;
    chunkIndex: number;
    totalChunks: number;
    chunk: Blob;
}
interface UploadedFileInfo {
    url?: string;
    savedName?: string;
}
interface ChunkUploadInitResult {
    uploadId?: string;
    uploadedChunks?: number[];
    totalChunks?: number;
    chunkSize?: number;
    completed?: boolean;
    fileInfo?: UploadedFileInfo | null;
}
type ChunkUploadStatusResult = ChunkUploadInitResult;
interface ChunkUploadCompleteResult {
    fileInfo?: UploadedFileInfo | null;
    files?: UploadedFileInfo[] | null;
}
interface UploadChunkOptions {
    signal?: AbortSignal;
    onProgress?: (loadedBytes: number, totalBytes: number) => void;
}
interface ChunkUploadStatusOptions {
    skipDedupe?: boolean;
}
interface ChunkUploadApi<InitResponse = unknown, StatusResponse = unknown, CompleteResponse = unknown> {
    init: (payload: ChunkUploadInitPayload) => Promise<InitResponse>;
    status: (uploadId: string, options?: ChunkUploadStatusOptions) => Promise<StatusResponse>;
    uploadChunk: (payload: ChunkUploadChunkPayload, options?: UploadChunkOptions) => Promise<unknown>;
    complete: (uploadId: string) => Promise<CompleteResponse>;
}
interface StorageAdapter {
    get: <T = unknown>(key: string) => T | null | undefined;
    set: (key: string, value: unknown) => void;
    remove: (key: string) => void;
}
interface LargeFileUploadMessages {
    waitingFile?: string;
    offlinePause?: string;
    manualPause?: string;
    uploadFailed?: string;
    restoredWaitingFile?: string;
    missingUrl?: string;
}
interface AdaptiveConcurrencyOptions {
    enabled?: boolean;
    min?: number;
    max?: number;
    increaseStep?: number;
    decreaseStep?: number;
    successThreshold?: number;
    failureThreshold?: number;
    windowSize?: number;
}
interface RetryContext {
    error: unknown;
    attempt: number;
    maxAttempts: number;
    isLastAttempt: boolean;
    statusCode: number;
    isNetworkError: boolean;
    isConflictError: boolean;
}
type RetryDecider = (context: RetryContext) => boolean;
type RetryDelayResolver = (context: RetryContext) => number;
interface LargeFileUploadOptions<InitResponse = unknown, StatusResponse = unknown, CompleteResponse = unknown> {
    api: ChunkUploadApi<InitResponse, StatusResponse, CompleteResponse>;
    resolveInitResponse?: (response: InitResponse) => ChunkUploadInitResult;
    resolveStatusResponse?: (response: StatusResponse) => ChunkUploadStatusResult;
    resolveCompleteResponse?: (response: CompleteResponse) => ChunkUploadCompleteResult;
    resolveUploadedUrl: (fileInfo?: UploadedFileInfo | null, fallbackUrl?: unknown) => string;
    buildFingerprint?: (file: File) => Promise<string> | string;
    storage?: StorageAdapter;
    storageKey?: string;
    taskCacheLimit?: number;
    chunkSize?: number | ((file: File) => number);
    retryTimes?: number;
    retryBaseDelayMs?: number;
    retryMaxDelayMs?: number;
    retryJitterRatio?: number;
    resolveRetryDelayMs?: RetryDelayResolver;
    shouldRetry?: RetryDecider;
    chunkConcurrency?: number | ((file: File) => number);
    adaptiveConcurrency?: boolean | AdaptiveConcurrencyOptions;
    progressIntervalMs?: number;
    progressDeltaPercent?: number;
    isOnline?: () => boolean;
    messages?: LargeFileUploadMessages;
    onTaskStart?: (task: LargeFileUploadTask, file: File) => void;
    onTaskProgress?: (task: LargeFileUploadTask, progress: number, uploadedBytes: number, totalBytes: number) => void;
    onTaskStatusChange?: (task: LargeFileUploadTask, previousStatus: LargeFileTaskStatus, nextStatus: LargeFileTaskStatus) => void;
    onTaskError?: (task: LargeFileUploadTask, error: unknown) => void;
    onChunkSuccess?: (task: LargeFileUploadTask, chunkIndex: number) => void;
    onChunkError?: (task: LargeFileUploadTask, chunkIndex: number, error: unknown, attempt: number) => void;
    onTaskComplete?: (task: LargeFileUploadTask, url: string, file: File | null) => void;
}
interface LargeFileUploadManager {
    getState: () => LargeFileUploadState;
    subscribe: (listener: (state: LargeFileUploadState) => void) => () => void;
    upload: (file: File) => Promise<LargeFileUploadResult>;
    resume: (uploadId: string, file?: File) => Promise<boolean>;
    pause: (uploadId: string) => void;
    remove: (uploadId: string) => void;
    pauseAll: () => void;
    resumePaused: () => void;
    dispose: () => void;
    getTaskById: (uploadId: string) => LargeFileUploadTask | undefined;
    getTaskByFingerprint: (fingerprint: string) => LargeFileUploadTask | undefined;
}

declare const resolveTaskUploadedBytes: (task: LargeFileUploadTask, chunkLoadedBytesMap: Record<string, number>) => number;
declare const resolveTaskProgressPercent: (task: LargeFileUploadTask, chunkLoadedBytesMap: Record<string, number>) => number;
declare const resolveOverallProgress: (tasks: LargeFileUploadTask[], chunkLoadedBytesMap: Record<string, number>) => number;

declare const formatFileSize: (size: number) => string;

declare const buildFileFingerprint: (file: File) => Promise<string>;

declare const createLargeFileUploadManager: <InitResponse = unknown, StatusResponse = unknown, CompleteResponse = unknown>(options: LargeFileUploadOptions<InitResponse, StatusResponse, CompleteResponse>) => LargeFileUploadManager;

export { type ChunkUploadApi, type ChunkUploadChunkPayload, type ChunkUploadInitPayload, type ChunkUploadStatusOptions, type ChunkUploadStatusResult, type LargeFileTaskStatus, type LargeFileUploadManager, type LargeFileUploadMessages, type LargeFileUploadOptions, type LargeFileUploadResult, type LargeFileUploadState, type LargeFileUploadTask, type StorageAdapter, type UploadChunkOptions, type UploadedFileInfo, buildFileFingerprint, createLargeFileUploadManager, formatFileSize, resolveOverallProgress, resolveTaskProgressPercent, resolveTaskUploadedBytes };
