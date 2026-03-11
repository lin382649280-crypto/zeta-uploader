import type {
  ChunkUploadCompleteResult,
  ChunkUploadInitResult,
  ChunkUploadStatusResult,
  LargeFileTaskStatus,
  LargeFileUploadManager,
  LargeFileUploadOptions,
  LargeFileUploadResult,
  LargeFileUploadState,
  LargeFileUploadTask,
} from './types';
import {
  CHUNK_PROGRESS_FLUSH_INTERVAL_MS,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_MESSAGES,
  DEFAULT_PROGRESS_DELTA_PERCENT,
  DEFAULT_PROGRESS_INTERVAL_MS,
  DEFAULT_RETRY_BASE_DELAY_MS,
  DEFAULT_RETRY_JITTER_RATIO,
  DEFAULT_RETRY_MAX_DELAY_MS,
  DEFAULT_RETRY_TIMES,
  DEFAULT_STORAGE_KEY,
  DEFAULT_TASK_CACHE_LIMIT,
  OFFLINE_ERROR,
  WAITING_FILE_ERROR,
} from './constants';
import { clamp, toInt } from './utils/number';
import { resolveDefaultIsOnline, resolvePreferredChunkConcurrency } from './utils/env';
import { sleep } from './utils/time';
import {
  isAbortError,
  isChunkUploadConflictError,
  isLikelyNetworkError,
  isRetryableError,
  resolveErrorStatus,
} from './utils/error';
import { normalizeChunkIndexes } from './utils/chunk';
import { resolveTaskProgressPercent, resolveTaskUploadedBytes } from './utils/progress';
import { buildFileFingerprint } from './utils/fingerprint';
import { createBrowserStorage } from './storage/browser-storage';
import { insertSortedUnique } from './utils/array';
import { resolveRetryDelayMs } from './utils/retry';

export type {
  ChunkUploadApi,
  ChunkUploadChunkPayload,
  ChunkUploadInitPayload,
  ChunkUploadStatusOptions,
  ChunkUploadStatusResult,
  LargeFileTaskStatus,
  LargeFileUploadManager,
  LargeFileUploadMessages,
  LargeFileUploadOptions,
  LargeFileUploadResult,
  LargeFileUploadState,
  LargeFileUploadTask,
  StorageAdapter,
  UploadChunkOptions,
  UploadedFileInfo,
} from './types';
export { resolveTaskUploadedBytes, resolveTaskProgressPercent, resolveOverallProgress } from './utils/progress';
export { formatFileSize } from './utils/format';
export { buildFileFingerprint } from './utils/fingerprint';

interface TaskRuntime {
  file: File | null;
  uploadPromise: Promise<string> | null;
  controllers: Map<number, AbortController>;
  lastProgressAt: number;
  lastProgressValue: number;
}

// 核心入口：创建大文件上传管理器
// - 负责分片上传、断点续传、任务管理、状态通知
// - 不依赖具体 UI，可在 Vue/React/原生中复用
export const createLargeFileUploadManager = <
  InitResponse = unknown,
  StatusResponse = unknown,
  CompleteResponse = unknown,
>(
  options: LargeFileUploadOptions<InitResponse, StatusResponse, CompleteResponse>,
): LargeFileUploadManager => {
  // 1) 基础配置解析（含默认值与兜底）
  const messages = { ...DEFAULT_MESSAGES, ...(options.messages || {}) };
  const storage = options.storage ?? createBrowserStorage();
  const storageKey = String(options.storageKey || DEFAULT_STORAGE_KEY);
  const taskCacheLimit = Math.max(1, toInt(options.taskCacheLimit, DEFAULT_TASK_CACHE_LIMIT));
  const defaultChunkSize = Math.max(
    1,
    toInt(typeof options.chunkSize === 'number' ? options.chunkSize : DEFAULT_CHUNK_SIZE, DEFAULT_CHUNK_SIZE),
  );
  // 支持按文件动态分片大小：例如大文件用更大的分片、小文件用更小的分片
  const resolveChunkSize = (file: File) => {
    if (typeof options.chunkSize === 'function') {
      return Math.max(1, toInt(options.chunkSize(file), defaultChunkSize));
    }
    return defaultChunkSize;
  };
  // 重试次数与退避策略
  const retryTimes = clamp(toInt(options.retryTimes, DEFAULT_RETRY_TIMES), 1, 12);
  const retryBaseDelayMs = Math.max(0, toInt(options.retryBaseDelayMs, DEFAULT_RETRY_BASE_DELAY_MS));
  const retryMaxDelayMs = Math.max(retryBaseDelayMs, toInt(options.retryMaxDelayMs, DEFAULT_RETRY_MAX_DELAY_MS));
  const retryJitterRatio = clamp(
    Number.isFinite(options.retryJitterRatio) ? Number(options.retryJitterRatio) : DEFAULT_RETRY_JITTER_RATIO,
    0,
    1,
  );
  // 进度节流：避免频繁触发 UI 更新导致卡顿
  const progressIntervalMs = Math.max(0, toInt(options.progressIntervalMs, DEFAULT_PROGRESS_INTERVAL_MS));
  const progressDeltaPercent = clamp(
    Number.isFinite(options.progressDeltaPercent)
      ? Number(options.progressDeltaPercent)
      : DEFAULT_PROGRESS_DELTA_PERCENT,
    0,
    100,
  );
  const resolveInit = options.resolveInitResponse ?? ((res: InitResponse) => res as ChunkUploadInitResult);
  const resolveStatus = options.resolveStatusResponse ?? ((res: StatusResponse) => res as ChunkUploadStatusResult);
  const resolveComplete =
    options.resolveCompleteResponse ?? ((res: CompleteResponse) => res as ChunkUploadCompleteResult);
  const isOnline = options.isOnline ?? resolveDefaultIsOnline;
  // 事件回调（可选）
  const onTaskComplete = options.onTaskComplete;
  const onTaskStart = options.onTaskStart;
  const onTaskProgress = options.onTaskProgress;
  const onTaskStatusChange = options.onTaskStatusChange;
  const onTaskError = options.onTaskError;
  const onChunkSuccess = options.onChunkSuccess;
  const onChunkError = options.onChunkError;
  let disposed = false;

  // 2) 内部状态：任务列表 + 分片进度表
  const state: LargeFileUploadState = {
    tasks: [],
    chunkLoadedBytesMap: {},
  };
  // 监听器：外部 subscribe 用于 UI 更新
  const listeners = new Set<(snapshot: LargeFileUploadState) => void>();
  // 运行时缓存：保存文件句柄、控制器、进度节流信息
  const taskRuntimeMap = new Map<string, TaskRuntime>();
  // 分片进度暂存：避免频繁 setState
  const pendingChunkLoadedUpdates = new Map<string, number | null>();
  let persistTimer: number | null = null;
  let chunkProgressFlushTimer: number | null = null;

  // 获取只读快照，避免外部直接修改内部状态
  const getSnapshot = (): LargeFileUploadState => ({
    tasks: [...state.tasks],
    chunkLoadedBytesMap: { ...state.chunkLoadedBytesMap },
  });

  // 通知所有订阅者（UI 层）
  const notify = () => {
    if (!listeners.size) return;
    const snapshot = getSnapshot();
    listeners.forEach((listener) => listener(snapshot));
  };

  // 立刻持久化（保存到 storage）
  const persistNow = () => {
    if (!storage) return;
    const list = state.tasks.slice(0, taskCacheLimit);
    if (!list.length) {
      storage.remove(storageKey);
      return;
    }
    storage.set(storageKey, list);
  };

  // 延迟持久化：减少频繁写 localStorage
  const schedulePersist = () => {
    if (!storage || disposed) return;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persistNow();
    }, 220);
  };

  // 进度刷新调度：合并多次进度更新
  const scheduleChunkProgressFlush = (immediate = false) => {
    if (immediate) {
      if (chunkProgressFlushTimer) {
        clearTimeout(chunkProgressFlushTimer);
        chunkProgressFlushTimer = null;
      }
      flushChunkProgressUpdates();
      return;
    }
    if (chunkProgressFlushTimer) return;
    chunkProgressFlushTimer = setTimeout(() => {
      chunkProgressFlushTimer = null;
      flushChunkProgressUpdates();
    }, CHUNK_PROGRESS_FLUSH_INTERVAL_MS);
  };

  // 将暂存的分片进度应用到全局 state
  const flushChunkProgressUpdates = () => {
    if (!pendingChunkLoadedUpdates.size) return;
    const touchedTaskIds = new Set<string>();
    const nextMap = { ...state.chunkLoadedBytesMap };
    pendingChunkLoadedUpdates.forEach((value, key) => {
      const separatorIndex = key.indexOf(':');
      if (separatorIndex > 0) touchedTaskIds.add(key.slice(0, separatorIndex));
      if (value === null) {
        delete nextMap[key];
      } else {
        nextMap[key] = value;
      }
    });
    pendingChunkLoadedUpdates.clear();
    state.chunkLoadedBytesMap = nextMap;
    // 同步刷新被影响的任务进度
    if (touchedTaskIds.size) {
      touchedTaskIds.forEach((uploadId) => {
        const task = getTaskById(uploadId);
        if (!task) return;
        const nextProgress = resolveTaskProgressPercent(task, state.chunkLoadedBytesMap);
        if (task.progress !== nextProgress) {
          task.progress = nextProgress;
          if (shouldEmitProgress(uploadId, nextProgress)) {
            markProgressEmitted(uploadId, nextProgress);
            if (onTaskProgress) {
              const uploadedBytes = resolveTaskUploadedBytes(task, state.chunkLoadedBytesMap);
              onTaskProgress(task, nextProgress, uploadedBytes, task.fileSize);
            }
          }
        }
      });
    }
    notify();
  };

  // 设置某个分片已上传的字节数（临时缓存）
  const setChunkLoadedBytes = (uploadId: string, chunkIndex: number, loadedBytes: number) => {
    const key = `${uploadId}:${chunkIndex}`;
    const safeLoaded = Math.max(0, Math.floor(Number(loadedBytes || 0)));
    if (pendingChunkLoadedUpdates.get(key) === safeLoaded) return;
    pendingChunkLoadedUpdates.set(key, safeLoaded);
    scheduleChunkProgressFlush(false);
  };

  // 清除某个分片的进度（通常在分片完成或失败时）
  const clearChunkLoadedBytes = (uploadId: string, chunkIndex: number) => {
    const key = `${uploadId}:${chunkIndex}`;
    if (pendingChunkLoadedUpdates.get(key) === null) return;
    pendingChunkLoadedUpdates.set(key, null);
    scheduleChunkProgressFlush(true);
  };

  // 清除某任务的所有分片进度（用于暂停/移除）
  const clearTaskChunkLoadedBytes = (uploadId: string) => {
    const prefix = `${uploadId}:`;
    let touched = false;
    Object.keys(state.chunkLoadedBytesMap).forEach((key) => {
      if (key.startsWith(prefix)) {
        pendingChunkLoadedUpdates.set(key, null);
        touched = true;
      }
    });
    Array.from(pendingChunkLoadedUpdates.keys()).forEach((key) => {
      if (key.startsWith(prefix)) {
        pendingChunkLoadedUpdates.set(key, null);
        touched = true;
      }
    });
    if (touched) scheduleChunkProgressFlush(true);
  };

  // 查询任务（根据 uploadId / fingerprint）
  const getTaskById = (uploadId: string) => state.tasks.find((item) => item.uploadId === uploadId);
  const getTaskByFingerprint = (fingerprint: string) =>
    state.tasks.find((item) => item.fingerprint === fingerprint);

  // 获取或创建任务运行时上下文
  const ensureRuntime = (uploadId: string) => {
    let runtime = taskRuntimeMap.get(uploadId);
    if (!runtime) {
      runtime = {
        file: null,
        uploadPromise: null,
        controllers: new Map<number, AbortController>(),
        lastProgressAt: 0,
        lastProgressValue: -1,
      };
      taskRuntimeMap.set(uploadId, runtime);
    }
    return runtime;
  };

  // 取消某个任务的所有分片请求
  const abortRuntime = (runtime: TaskRuntime | undefined) => {
    if (!runtime) return;
    runtime.controllers.forEach((controller) => controller.abort());
    runtime.controllers.clear();
  };

  // 更新任务并可选择性触发通知/持久化
  const touchTask = (
    task: LargeFileUploadTask,
    options?: { notify?: boolean; persist?: boolean; updateTimestamp?: boolean },
  ) => {
    const notifyEnabled = options?.notify ?? true;
    const persistEnabled = options?.persist ?? true;
    const updateTimestamp = options?.updateTimestamp ?? true;
    if (updateTimestamp) {
      task.updatedAt = Date.now();
    }
    if (persistEnabled) schedulePersist();
    if (notifyEnabled) notify();
  };

  // 统一更新任务状态，并通知外部回调
  const setTaskStatus = (
    task: LargeFileUploadTask,
    status: LargeFileTaskStatus,
    message = '',
    options?: { notify?: boolean },
  ) => {
    const prevStatus = task.status;
    task.status = status;
    task.errorMessage = message;
    touchTask(task, { notify: options?.notify ?? true });
    if (prevStatus !== status && onTaskStatusChange) {
      onTaskStatusChange(task, prevStatus, status);
    }
  };

  // 是否需要触发 progress 回调（节流/阈值控制）
  const shouldEmitProgress = (uploadId: string, nextProgress: number) => {
    const runtime = ensureRuntime(uploadId);
    if (nextProgress >= 100) return true;
    if (runtime.lastProgressValue < 0) return true;
    const now = Date.now();
    if (progressIntervalMs > 0 && now - runtime.lastProgressAt >= progressIntervalMs) return true;
    if (progressDeltaPercent <= 0) return true;
    return Math.abs(nextProgress - runtime.lastProgressValue) >= progressDeltaPercent;
  };

  // 记录已触发的进度信息
  const markProgressEmitted = (uploadId: string, progress: number) => {
    const runtime = ensureRuntime(uploadId);
    runtime.lastProgressAt = Date.now();
    runtime.lastProgressValue = progress;
  };

  // 更新任务进度（支持增量插入分片索引）
  const updateTaskProgress = (
    task: LargeFileUploadTask,
    uploadedSet: Set<number>,
    changedIndex?: number | null,
    replaceAll = false,
  ) => {
    if (replaceAll || changedIndex === null || changedIndex === undefined) {
      task.uploadedChunkIndexes = Array.from(uploadedSet).sort((a, b) => a - b);
    } else {
      insertSortedUnique(task.uploadedChunkIndexes, changedIndex);
    }
    const nextProgress = resolveTaskProgressPercent(task, state.chunkLoadedBytesMap);
    task.progress = nextProgress;
    if (shouldEmitProgress(task.uploadId, nextProgress)) {
      markProgressEmitted(task.uploadId, nextProgress);
      touchTask(task);
      if (onTaskProgress) {
        const uploadedBytes = resolveTaskUploadedBytes(task, state.chunkLoadedBytesMap);
        onTaskProgress(task, nextProgress, uploadedBytes, task.fileSize);
      }
    } else {
      // 不触发 UI 更新时，仍然持久化
      touchTask(task, { notify: false, updateTimestamp: false });
    }
  };

  // 移除任务（含运行时资源 + 进度缓存）
  const removeTask = (uploadId: string) => {
    const index = state.tasks.findIndex((item) => item.uploadId === uploadId);
    if (index >= 0) state.tasks.splice(index, 1);
    const runtime = taskRuntimeMap.get(uploadId);
    abortRuntime(runtime);
    taskRuntimeMap.delete(uploadId);
    clearTaskChunkLoadedBytes(uploadId);
    schedulePersist();
    notify();
  };

  // 任务完成：执行回调 + 清理任务
  const finishTask = (uploadId: string, url: string) => {
    const runtime = taskRuntimeMap.get(uploadId);
    const task = getTaskById(uploadId);
    try {
      if (task && onTaskComplete) {
        onTaskComplete(task, url, runtime?.file || null);
      }
    } finally {
      removeTask(uploadId);
    }
  };

  // 执行任务上传流程（核心逻辑）
  const runTaskUpload = async (task: LargeFileUploadTask): Promise<string> => {
    const runtime = ensureRuntime(task.uploadId);
    if (runtime.uploadPromise) return runtime.uploadPromise;

    runtime.uploadPromise = (async () => {
      if (!runtime.file) {
        setTaskStatus(task, 'waiting_file', messages.waitingFile);
        throw new Error(WAITING_FILE_ERROR);
      }
      if (!isOnline()) {
        setTaskStatus(task, 'paused', messages.offlinePause);
        throw new Error(OFFLINE_ERROR);
      }

      // 标记任务开始上传
      setTaskStatus(task, 'uploading', '');
      if (onTaskStart) {
        onTaskStart(task, runtime.file);
      }

      // 先拉取服务端状态（处理断点续传）
      const statusRes = await options.api.status(task.uploadId, { skipDedupe: false });
      const statusPayload = resolveStatus(statusRes as StatusResponse);
      const uploadedSet = new Set<number>(normalizeChunkIndexes(statusPayload.uploadedChunks, task.totalChunks));
      updateTaskProgress(task, uploadedSet, null, true);

      const completedUrl = options.resolveUploadedUrl(statusPayload.fileInfo);
      if (statusPayload.completed && completedUrl) {
        finishTask(task.uploadId, completedUrl);
        return completedUrl;
      }

      // 计算待上传分片列表
      const pendingIndexes: number[] = [];
      for (let i = 0; i < task.totalChunks; i += 1) {
        if (!uploadedSet.has(i)) pendingIndexes.push(i);
      }

      let cursor = 0;
      let fatalError: unknown = null;
      // 并发数的默认解析
      const resolveConcurrency = () => {
        if (!pendingIndexes.length) return 1;
        if (typeof options.chunkConcurrency === 'function') {
          return clamp(options.chunkConcurrency(runtime.file!), 1, pendingIndexes.length);
        }
        if (typeof options.chunkConcurrency === 'number') {
          return clamp(options.chunkConcurrency, 1, pendingIndexes.length);
        }
        return Math.max(1, Math.min(resolvePreferredChunkConcurrency(), pendingIndexes.length));
      };
      const baseConcurrency = resolveConcurrency();
      // 自适应并发策略（根据成功/失败动态调整并发）
      const adaptiveInput = options.adaptiveConcurrency;
      const adaptive =
        adaptiveInput === undefined || adaptiveInput === false
          ? { enabled: false }
          : adaptiveInput === true
            ? { enabled: true }
            : { enabled: true, ...adaptiveInput };
      const adaptiveMin = clamp(toInt(adaptive.min, 1), 1, pendingIndexes.length || 1);
      const adaptiveMax = clamp(toInt(adaptive.max, baseConcurrency), adaptiveMin, pendingIndexes.length || 1);
      const adaptiveIncrease = clamp(toInt(adaptive.increaseStep, 1), 1, pendingIndexes.length || 1);
      const adaptiveDecrease = clamp(toInt(adaptive.decreaseStep, 1), 1, pendingIndexes.length || 1);
      const adaptiveWindow = clamp(toInt(adaptive.windowSize, 6), 2, 20);
      const adaptiveSuccessThreshold = clamp(toInt(adaptive.successThreshold, 4), 1, adaptiveWindow);
      const adaptiveFailureThreshold = clamp(toInt(adaptive.failureThreshold, 2), 1, adaptiveWindow);
      let maxConcurrent = adaptive.enabled ? clamp(baseConcurrency, adaptiveMin, adaptiveMax) : baseConcurrency;
      const adaptiveOutcomes: boolean[] = [];

      // 记录上传结果，用于调整并发
      const recordOutcome = (ok: boolean) => {
        if (!adaptive.enabled) return;
        adaptiveOutcomes.push(ok);
        if (adaptiveOutcomes.length > adaptiveWindow) adaptiveOutcomes.shift();
        const failureCount = adaptiveOutcomes.filter((item) => !item).length;
        const successCount = adaptiveOutcomes.length - failureCount;
        if (failureCount >= adaptiveFailureThreshold && maxConcurrent > adaptiveMin) {
          maxConcurrent = Math.max(adaptiveMin, maxConcurrent - adaptiveDecrease);
          adaptiveOutcomes.length = 0;
        } else if (successCount >= adaptiveSuccessThreshold && failureCount === 0 && maxConcurrent < adaptiveMax) {
          maxConcurrent = Math.min(adaptiveMax, maxConcurrent + adaptiveIncrease);
          adaptiveOutcomes.length = 0;
        }
      };

      // 是否重试：可由用户自定义，否则使用默认策略
      const shouldRetry = options.shouldRetry ?? ((context) => context.isConflictError || isRetryableError(context.error));

      // 上传单个分片（含重试与冲突处理）
      const processChunk = async (chunkIndex: number) => {
        for (let attempt = 0; attempt < retryTimes; attempt += 1) {
          if (!isOnline()) {
            throw new Error(OFFLINE_ERROR);
          }

          const start = chunkIndex * task.chunkSize;
          const end = Math.min(start + task.chunkSize, runtime.file!.size);
          const currentChunkSize = Math.max(0, end - start);
          const controller = new AbortController();
          runtime.controllers.set(chunkIndex, controller);

          try {
            // 调用用户提供的分片上传 API
            await options.api.uploadChunk(
              {
                uploadId: task.uploadId,
                chunkIndex,
                totalChunks: task.totalChunks,
                chunk: runtime.file!.slice(start, end),
              },
              {
                signal: controller.signal,
                onProgress: (loaded) => {
                  const safeLoaded = Math.min(Number(loaded || 0), currentChunkSize);
                  setChunkLoadedBytes(task.uploadId, chunkIndex, safeLoaded);
                },
              },
            );
            clearChunkLoadedBytes(task.uploadId, chunkIndex);
            if (!uploadedSet.has(chunkIndex)) {
              uploadedSet.add(chunkIndex);
              updateTaskProgress(task, uploadedSet, chunkIndex);
            } else {
              updateTaskProgress(task, uploadedSet, null, true);
            }
            if (onChunkSuccess) onChunkSuccess(task, chunkIndex);
            return;
          } catch (error) {
            clearChunkLoadedBytes(task.uploadId, chunkIndex);
            const isConflictError = isChunkUploadConflictError(error);

            if (isConflictError) {
              // 如果服务端提示冲突（例如重复上传），重新拉状态以确认分片是否已存在
              try {
                const statusRes = await options.api.status(task.uploadId, { skipDedupe: true });
                const statusPayload = resolveStatus(statusRes as StatusResponse);
                const latestUploaded = normalizeChunkIndexes(statusPayload.uploadedChunks, task.totalChunks);
                let changed = false;
                latestUploaded.forEach((index) => {
                  if (!uploadedSet.has(index)) {
                    uploadedSet.add(index);
                    changed = true;
                  }
                });
                if (changed) {
                  updateTaskProgress(task, uploadedSet, null, true);
                }
                if (uploadedSet.has(chunkIndex)) {
                  if (onChunkSuccess) onChunkSuccess(task, chunkIndex);
                  return;
                }
              } catch {
                // ignore status check failure and continue retry policy
              }
            }

            // 构建重试上下文
            const context = {
              error,
              attempt,
              maxAttempts: retryTimes,
              isLastAttempt: attempt >= retryTimes - 1,
              statusCode: resolveErrorStatus(error),
              isNetworkError: isLikelyNetworkError(error),
              isConflictError,
            };
            if (onChunkError) onChunkError(task, chunkIndex, error, attempt + 1);

            // 不可重试 / 最后一次 / 主动取消 -> 直接抛出
            if (isAbortError(error) || context.isLastAttempt || !shouldRetry(context)) {
              throw error;
            }

            // 退避 + 抖动，避免重试风暴
            const delay = resolveRetryDelayMs(context, {
              baseDelayMs: retryBaseDelayMs,
              maxDelayMs: retryMaxDelayMs,
              jitterRatio: retryJitterRatio,
              customResolver: options.resolveRetryDelayMs,
            });
            await sleep(delay);
          } finally {
            runtime.controllers.delete(chunkIndex);
          }
        }
      };

      // 并发队列调度器
      const runQueue = async () =>
        new Promise<void>((resolve, reject) => {
          let active = 0;
          const launchNext = () => {
            if (fatalError) {
              if (active === 0) reject(fatalError);
              return;
            }
            while (active < maxConcurrent && cursor < pendingIndexes.length && !fatalError) {
              const chunkIndex = pendingIndexes[cursor];
              cursor += 1;
              if (!Number.isFinite(chunkIndex)) continue;
              active += 1;
              void processChunk(chunkIndex)
                .then(() => {
                  recordOutcome(true);
                  active -= 1;
                  if (cursor >= pendingIndexes.length && active === 0) {
                    resolve();
                    return;
                  }
                  launchNext();
                })
                .catch((error) => {
                  recordOutcome(false);
                  active -= 1;
                  if (!fatalError) {
                    fatalError = error;
                    abortRuntime(runtime);
                  }
                  if (cursor >= pendingIndexes.length && active === 0) {
                    reject(fatalError);
                    return;
                  }
                  launchNext();
                });
            }
            if (cursor >= pendingIndexes.length && active === 0) {
              resolve();
            }
          };
          launchNext();
        });

      await runQueue();
      if (fatalError) throw fatalError;

      // 所有分片上传成功 -> 调用合并/完成接口
      const completeRes = await options.api.complete(task.uploadId);
      const completePayload = resolveComplete(completeRes as CompleteResponse);
      const finalUrl = options.resolveUploadedUrl(completePayload.fileInfo, completePayload.files?.[0]?.url);
      if (!finalUrl) throw new Error(messages.missingUrl);
      finishTask(task.uploadId, finalUrl);
      return finalUrl;
    })()
      .catch((error) => {
        if (!(error instanceof Error && error.message === WAITING_FILE_ERROR)) {
          if (error instanceof Error && error.message === OFFLINE_ERROR) {
            setTaskStatus(task, 'paused', messages.offlinePause);
          } else if (isAbortError(error) || isLikelyNetworkError(error)) {
            if (task.status !== 'paused') {
              setTaskStatus(task, 'paused', messages.offlinePause);
            }
          } else {
            setTaskStatus(task, 'failed', messages.uploadFailed);
            if (onTaskError) onTaskError(task, error);
          }
        }
        throw error;
      })
      .finally(() => {
        runtime.uploadPromise = null;
      });

    return runtime.uploadPromise;
  };

  // 上传入口：创建/更新任务后启动上传流程
  const upload = async (file: File): Promise<LargeFileUploadResult> => {
    const fingerprint =
      (await (options.buildFingerprint ? options.buildFingerprint(file) : buildFileFingerprint(file))) ||
      `${file.name}|${file.size}|${file.type}|${file.lastModified}`;
    const resolvedChunkSize = resolveChunkSize(file);
    const totalChunks = Math.max(1, Math.ceil(file.size / resolvedChunkSize));

    const initRes = await options.api.init({
      fileHash: fingerprint,
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type,
      chunkSize: resolvedChunkSize,
      totalChunks,
    });
    const initPayload = resolveInit(initRes as InitResponse);
    const uploadId = String(initPayload.uploadId || '').trim();
    if (!uploadId) throw new Error('Failed to initialize chunk upload.');

    const uploadTotalChunks = toInt(initPayload.totalChunks, totalChunks);
    const uploadChunkSize = toInt(initPayload.chunkSize, resolvedChunkSize);
    const uploadedChunkIndexes = normalizeChunkIndexes(initPayload.uploadedChunks, uploadTotalChunks);
    const oldTask = getTaskByFingerprint(fingerprint);
    if (oldTask && oldTask.uploadId !== uploadId) removeTask(oldTask.uploadId);

    let task = getTaskById(uploadId);
    if (!task) {
      // 新任务
      task = {
        uploadId,
        fingerprint,
        fileName: file.name,
        fileSize: file.size,
        chunkSize: uploadChunkSize,
        totalChunks: uploadTotalChunks,
        uploadedChunkIndexes,
        status: 'uploading',
        errorMessage: '',
        updatedAt: Date.now(),
      };
      task.progress = resolveTaskProgressPercent(task, state.chunkLoadedBytesMap);
      state.tasks.unshift(task);
      if (state.tasks.length > taskCacheLimit) {
        state.tasks.splice(taskCacheLimit);
      }
      schedulePersist();
      notify();
    } else {
      // 已存在任务：更新文件与分片信息
      task.fileName = file.name;
      task.fileSize = file.size;
      task.fingerprint = fingerprint;
      task.chunkSize = uploadChunkSize;
      task.totalChunks = uploadTotalChunks;
      task.status = 'uploading';
      task.errorMessage = '';
      updateTaskProgress(task, new Set(uploadedChunkIndexes), null, true);
    }

    const runtime = ensureRuntime(uploadId);
    runtime.file = file;

    const completedUrl = options.resolveUploadedUrl(initPayload.fileInfo);
    if (initPayload.completed && completedUrl) {
      finishTask(uploadId, completedUrl);
      return { url: completedUrl, taskHandled: Boolean(onTaskComplete) };
    }

    const finalUrl = await runTaskUpload(task);
    return { url: finalUrl, taskHandled: Boolean(onTaskComplete) };
  };

  // 恢复上传：支持传入 file 重新绑定
  const resume = async (uploadId: string, file?: File) => {
    const task = getTaskById(uploadId);
    if (!task) return false;
    if (file) {
      const fingerprint =
        (await (options.buildFingerprint ? options.buildFingerprint(file) : buildFileFingerprint(file))) ||
        `${file.name}|${file.size}|${file.type}|${file.lastModified}`;
      if (task.fingerprint && fingerprint !== task.fingerprint) {
        setTaskStatus(task, 'waiting_file', messages.waitingFile);
        return false;
      }
      const runtime = ensureRuntime(uploadId);
      runtime.file = file;
      task.fileName = file.name;
      task.fileSize = file.size;
      task.fingerprint = fingerprint;
    }
    try {
      await runTaskUpload(task);
      return true;
    } catch {
      return false;
    }
  };

  // 暂停单个任务（不影响其他任务）
  const pause = (uploadId: string) => {
    const task = getTaskById(uploadId);
    if (!task) return;
    if (task.status === 'uploading') {
      setTaskStatus(task, 'paused', messages.manualPause);
    }
    const runtime = taskRuntimeMap.get(uploadId);
    abortRuntime(runtime);
    clearTaskChunkLoadedBytes(uploadId);
  };

  // 暂停所有任务（一般用于断网或页面挂起）
  const pauseAll = () => {
    let touched = false;
    state.tasks.forEach((task) => {
      if (task.status !== 'uploading') return;
      setTaskStatus(task, 'paused', messages.offlinePause, { notify: false });
      touched = true;
    });
    taskRuntimeMap.forEach((runtime) => abortRuntime(runtime));
    pendingChunkLoadedUpdates.clear();
    if (Object.keys(state.chunkLoadedBytesMap).length) {
      state.chunkLoadedBytesMap = {};
      touched = true;
    }
    if (touched) {
      schedulePersist();
      notify();
    }
  };

  // 恢复所有处于 paused 的任务（若仍在线）
  const resumePaused = () => {
    if (!isOnline()) return;
    state.tasks.forEach((task) => {
      if (task.status !== 'paused') return;
      const runtime = taskRuntimeMap.get(task.uploadId);
      if (!runtime?.file) return;
      void runTaskUpload(task).catch(() => {});
    });
  };

  // 释放资源（页面卸载/组件销毁时调用）
  const dispose = () => {
    if (persistTimer) clearTimeout(persistTimer);
    if (chunkProgressFlushTimer) clearTimeout(chunkProgressFlushTimer);
    pendingChunkLoadedUpdates.clear();
    persistNow();
    disposed = true;
    taskRuntimeMap.forEach((runtime) => abortRuntime(runtime));
    taskRuntimeMap.clear();
    listeners.clear();
  };

  // 从 storage 恢复任务（断点续传）
  const hydrateTasksFromStorage = () => {
    if (!storage) return;
    const cached = storage.get<LargeFileUploadTask[]>(storageKey);
    if (!Array.isArray(cached) || !cached.length) return;
    state.tasks = cached
      .slice(0, taskCacheLimit)
      .map((item) => {
        const totalChunks = Math.max(1, toInt(item.totalChunks, 1));
        const uploaded = normalizeChunkIndexes(item.uploadedChunkIndexes, totalChunks);
        const task: LargeFileUploadTask = {
          ...item,
          totalChunks,
          uploadedChunkIndexes: uploaded,
          status: 'waiting_file' as LargeFileTaskStatus,
          errorMessage: messages.restoredWaitingFile,
        };
        task.progress = resolveTaskProgressPercent(task, state.chunkLoadedBytesMap);
        return task;
      })
      .filter((item) => item.uploadId && item.fingerprint);
    schedulePersist();
    notify();
  };

  // 初始化：尝试恢复任务
  hydrateTasksFromStorage();

  return {
    getState: getSnapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      listener(getSnapshot());
      return () => listeners.delete(listener);
    },
    upload,
    resume,
    pause,
    remove: removeTask,
    pauseAll,
    resumePaused,
    dispose,
    getTaskById,
    getTaskByFingerprint,
  };
};
