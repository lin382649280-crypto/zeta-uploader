// 上传任务的状态枚举
export type LargeFileTaskStatus = 'uploading' | 'paused' | 'failed' | 'waiting_file';

// 单个上传任务的持久化结构
export interface LargeFileUploadTask {
  // 服务端返回的任务 ID
  uploadId: string;
  // 文件指纹（用于识别同一文件）
  fingerprint: string;
  // 文件名
  fileName: string;
  // 文件大小（字节）
  fileSize: number;
  // 分片大小（字节）
  chunkSize: number;
  // 分片总数
  totalChunks: number;
  // 已上传的分片索引
  uploadedChunkIndexes: number[];
  // 进度百分比（0-100）
  progress?: number;
  // 任务状态
  status: LargeFileTaskStatus;
  // 错误信息（UI 展示）
  errorMessage: string;
  // 最后更新时间（时间戳）
  updatedAt: number;
}

// 管理器对外暴露的状态
export interface LargeFileUploadState {
  // 所有任务
  tasks: LargeFileUploadTask[];
  // 分片实时进度（key = uploadId:chunkIndex）
  chunkLoadedBytesMap: Record<string, number>;
}

// 上传完成的返回结果
export interface LargeFileUploadResult {
  // 最终可访问 URL
  url: string;
  // 是否已由 onTaskComplete 处理（避免重复插入）
  taskHandled: boolean;
}

// 初始化分片上传的请求参数
export interface ChunkUploadInitPayload {
  // 文件 hash（指纹）
  fileHash: string;
  // 文件名
  fileName: string;
  // 文件大小
  fileSize: number;
  // MIME 类型
  mimeType: string;
  // 分片大小
  chunkSize: number;
  // 分片总数
  totalChunks: number;
}

// 上传单个分片的请求参数
export interface ChunkUploadChunkPayload {
  // 上传任务 ID
  uploadId: string;
  // 当前分片索引
  chunkIndex: number;
  // 分片总数
  totalChunks: number;
  // 分片二进制内容
  chunk: Blob;
}

// 服务端返回的已上传文件信息
export interface UploadedFileInfo {
  // 文件 URL
  url?: string;
  // 服务端保存后的文件名
  savedName?: string;
}

// 初始化接口返回的标准结构
export interface ChunkUploadInitResult {
  // 上传任务 ID
  uploadId?: string;
  // 已上传的分片索引
  uploadedChunks?: number[];
  // 分片总数
  totalChunks?: number;
  // 分片大小
  chunkSize?: number;
  // 是否已完成（服务端已存在该文件）
  completed?: boolean;
  // 文件信息（若已完成）
  fileInfo?: UploadedFileInfo | null;
}

// 状态接口返回结构与初始化一致
export type ChunkUploadStatusResult = ChunkUploadInitResult;

// 完成接口返回结构
export interface ChunkUploadCompleteResult {
  // 单文件返回
  fileInfo?: UploadedFileInfo | null;
  // 多文件返回（若后端支持）
  files?: UploadedFileInfo[] | null;
}

// 上传分片时可选参数
export interface UploadChunkOptions {
  // 外部取消信号
  signal?: AbortSignal;
  // 进度回调（loaded, total）
  onProgress?: (loadedBytes: number, totalBytes: number) => void;
}

// 查询上传状态时可选参数
export interface ChunkUploadStatusOptions {
  // 是否跳过去重逻辑
  skipDedupe?: boolean;
}

// 用户需提供的 API 接口
export interface ChunkUploadApi<
  InitResponse = unknown,
  StatusResponse = unknown,
  CompleteResponse = unknown,
> {
  // 初始化上传
  init: (payload: ChunkUploadInitPayload) => Promise<InitResponse>;
  // 查询上传状态
  status: (uploadId: string, options?: ChunkUploadStatusOptions) => Promise<StatusResponse>;
  // 上传分片
  uploadChunk: (payload: ChunkUploadChunkPayload, options?: UploadChunkOptions) => Promise<unknown>;
  // 完成上传（合并）
  complete: (uploadId: string) => Promise<CompleteResponse>;
}

// 用于任务持久化的存储适配器
export interface StorageAdapter {
  // 读取
  get: <T = unknown>(key: string) => T | null | undefined;
  // 写入
  set: (key: string, value: unknown) => void;
  // 删除
  remove: (key: string) => void;
}

// 文案配置
export interface LargeFileUploadMessages {
  // 等待重新选择文件的提示
  waitingFile?: string;
  // 离线暂停提示
  offlinePause?: string;
  // 手动暂停提示
  manualPause?: string;
  // 上传失败提示
  uploadFailed?: string;
  // 恢复任务后的提示
  restoredWaitingFile?: string;
  // 合并完成但 URL 缺失的提示
  missingUrl?: string;
}

// 自适应并发策略
export interface AdaptiveConcurrencyOptions {
  // 是否启用
  enabled?: boolean;
  // 最小并发数
  min?: number;
  // 最大并发数
  max?: number;
  // 提升并发的步长
  increaseStep?: number;
  // 降低并发的步长
  decreaseStep?: number;
  // 统计窗口大小
  windowSize?: number;
  // 连续成功阈值
  successThreshold?: number;
  // 连续失败阈值
  failureThreshold?: number;
}

// 重试上下文（用于自定义重试策略）
export interface RetryContext {
  // 原始错误
  error: unknown;
  // 当前第几次尝试（从 0 开始）
  attempt: number;
  // 最大尝试次数
  maxAttempts: number;
  // 是否最后一次
  isLastAttempt: boolean;
  // HTTP 状态码（若可解析）
  statusCode: number;
  // 是否网络错误
  isNetworkError: boolean;
  // 是否冲突错误（409）
  isConflictError: boolean;
}

// 是否需要重试的判断函数
export type RetryDecider = (context: RetryContext) => boolean;
// 计算重试延迟的函数
export type RetryDelayResolver = (context: RetryContext) => number;

// 管理器初始化配置
export interface LargeFileUploadOptions<
  InitResponse = unknown,
  StatusResponse = unknown,
  CompleteResponse = unknown,
> {
  // API 实现
  api: ChunkUploadApi<InitResponse, StatusResponse, CompleteResponse>;
  // 解析初始化响应
  resolveInitResponse?: (response: InitResponse) => ChunkUploadInitResult;
  // 解析状态响应
  resolveStatusResponse?: (response: StatusResponse) => ChunkUploadStatusResult;
  // 解析完成响应
  resolveCompleteResponse?: (response: CompleteResponse) => ChunkUploadCompleteResult;
  // 解析最终 URL（必须提供）
  resolveUploadedUrl: (fileInfo?: UploadedFileInfo | null, fallbackUrl?: unknown) => string;
  // 生成文件指纹
  buildFingerprint?: (file: File) => Promise<string> | string;
  // 持久化存储适配器
  storage?: StorageAdapter;
  // storage key
  storageKey?: string;
  // 任务缓存上限
  taskCacheLimit?: number;
  // 分片大小（固定值或函数）
  chunkSize?: number | ((file: File) => number);
  // 重试次数
  retryTimes?: number;
  // 重试基础延迟
  retryBaseDelayMs?: number;
  // 重试最大延迟
  retryMaxDelayMs?: number;
  // 重试抖动比例
  retryJitterRatio?: number;
  // 自定义重试延迟
  resolveRetryDelayMs?: RetryDelayResolver;
  // 自定义是否重试
  shouldRetry?: RetryDecider;
  // 分片并发数量（固定值或函数）
  chunkConcurrency?: number | ((file: File) => number);
  // 自适应并发设置
  adaptiveConcurrency?: boolean | AdaptiveConcurrencyOptions;
  // 进度回调最小间隔
  progressIntervalMs?: number;
  // 进度回调最小变化百分比
  progressDeltaPercent?: number;
  // 网络检测函数
  isOnline?: () => boolean;
  // 文案覆盖
  messages?: LargeFileUploadMessages;
  // 任务开始回调
  onTaskStart?: (task: LargeFileUploadTask, file: File) => void;
  // 任务进度回调
  onTaskProgress?: (
    task: LargeFileUploadTask,
    progress: number,
    uploadedBytes: number,
    totalBytes: number,
  ) => void;
  // 任务状态变化回调
  onTaskStatusChange?: (
    task: LargeFileUploadTask,
    previousStatus: LargeFileTaskStatus,
    nextStatus: LargeFileTaskStatus,
  ) => void;
  // 任务错误回调
  onTaskError?: (task: LargeFileUploadTask, error: unknown) => void;
  // 分片成功回调
  onChunkSuccess?: (task: LargeFileUploadTask, chunkIndex: number) => void;
  // 分片失败回调
  onChunkError?: (task: LargeFileUploadTask, chunkIndex: number, error: unknown, attempt: number) => void;
  // 任务完成回调
  onTaskComplete?: (task: LargeFileUploadTask, url: string, file: File | null) => void;
}

// 管理器对外暴露的 API
export interface LargeFileUploadManager {
  // 获取当前状态快照
  getState: () => LargeFileUploadState;
  // 订阅状态变更
  subscribe: (listener: (state: LargeFileUploadState) => void) => () => void;
  // 开始上传
  upload: (file: File) => Promise<LargeFileUploadResult>;
  // 恢复上传（可重新传入文件）
  resume: (uploadId: string, file?: File) => Promise<boolean>;
  // 暂停单个任务
  pause: (uploadId: string) => void;
  // 移除任务
  remove: (uploadId: string) => void;
  // 暂停所有任务
  pauseAll: () => void;
  // 恢复所有暂停任务
  resumePaused: () => void;
  // 释放资源
  dispose: () => void;
  // 通过 ID 获取任务
  getTaskById: (uploadId: string) => LargeFileUploadTask | undefined;
  // 通过指纹获取任务
  getTaskByFingerprint: (fingerprint: string) => LargeFileUploadTask | undefined;
}
