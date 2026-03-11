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
  DEFAULT_RETRY_TIMES,
  DEFAULT_STORAGE_KEY,
  DEFAULT_TASK_CACHE_LIMIT,
  OFFLINE_ERROR,
  WAITING_FILE_ERROR,
} from './constants';
import { clamp, toInt } from './utils/number';
import { resolveDefaultIsOnline, resolvePreferredChunkConcurrency } from './utils/env';
import { sleep } from './utils/time';
import { isAbortError, isChunkUploadConflictError, isLikelyNetworkError } from './utils/error';
import { normalizeChunkIndexes } from './utils/chunk';
import { resolveTaskProgressPercent } from './utils/progress';
import { buildFileFingerprint } from './utils/fingerprint';
import { createBrowserStorage } from './storage/browser-storage';
import { insertSortedUnique } from './utils/array';

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
}

export const createLargeFileUploadManager = <
  InitResponse = unknown,
  StatusResponse = unknown,
  CompleteResponse = unknown,
>(
  options: LargeFileUploadOptions<InitResponse, StatusResponse, CompleteResponse>,
): LargeFileUploadManager => {
  const messages = { ...DEFAULT_MESSAGES, ...(options.messages || {}) };
  const storage = options.storage ?? createBrowserStorage();
  const storageKey = String(options.storageKey || DEFAULT_STORAGE_KEY);
  const taskCacheLimit = Math.max(1, toInt(options.taskCacheLimit, DEFAULT_TASK_CACHE_LIMIT));
  const chunkSize = Math.max(1, toInt(options.chunkSize, DEFAULT_CHUNK_SIZE));
  const retryTimes = clamp(toInt(options.retryTimes, DEFAULT_RETRY_TIMES), 1, 8);
  const resolveInit = options.resolveInitResponse ?? ((res: InitResponse) => res as ChunkUploadInitResult);
  const resolveStatus = options.resolveStatusResponse ?? ((res: StatusResponse) => res as ChunkUploadStatusResult);
  const resolveComplete =
    options.resolveCompleteResponse ?? ((res: CompleteResponse) => res as ChunkUploadCompleteResult);
  const isOnline = options.isOnline ?? resolveDefaultIsOnline;
  const onTaskComplete = options.onTaskComplete;
  let disposed = false;

  const state: LargeFileUploadState = {
    tasks: [],
    chunkLoadedBytesMap: {},
  };
  const listeners = new Set<(snapshot: LargeFileUploadState) => void>();
  const taskRuntimeMap = new Map<string, TaskRuntime>();
  const pendingChunkLoadedUpdates = new Map<string, number | null>();
  let persistTimer: number | null = null;
  let chunkProgressFlushTimer: number | null = null;

  const getSnapshot = (): LargeFileUploadState => ({
    tasks: [...state.tasks],
    chunkLoadedBytesMap: { ...state.chunkLoadedBytesMap },
  });

  const notify = () => {
    if (!listeners.size) return;
    const snapshot = getSnapshot();
    listeners.forEach((listener) => listener(snapshot));
  };

  const persistNow = () => {
    if (!storage) return;
    const list = state.tasks.slice(0, taskCacheLimit);
    if (!list.length) {
      storage.remove(storageKey);
      return;
    }
    storage.set(storageKey, list);
  };

  const schedulePersist = () => {
    if (!storage || disposed) return;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persistNow();
    }, 220);
  };

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

  const flushChunkProgressUpdates = () => {
    if (!pendingChunkLoadedUpdates.size) return;
    const nextMap = { ...state.chunkLoadedBytesMap };
    pendingChunkLoadedUpdates.forEach((value, key) => {
      if (value === null) {
        delete nextMap[key];
      } else {
        nextMap[key] = value;
      }
    });
    pendingChunkLoadedUpdates.clear();
    state.chunkLoadedBytesMap = nextMap;
    notify();
  };

  const setChunkLoadedBytes = (uploadId: string, chunkIndex: number, loadedBytes: number) => {
    const key = `${uploadId}:${chunkIndex}`;
    const safeLoaded = Math.max(0, Math.floor(Number(loadedBytes || 0)));
    if (pendingChunkLoadedUpdates.get(key) === safeLoaded) return;
    pendingChunkLoadedUpdates.set(key, safeLoaded);
    scheduleChunkProgressFlush(false);
  };

  const clearChunkLoadedBytes = (uploadId: string, chunkIndex: number) => {
    const key = `${uploadId}:${chunkIndex}`;
    if (pendingChunkLoadedUpdates.get(key) === null) return;
    pendingChunkLoadedUpdates.set(key, null);
    scheduleChunkProgressFlush(true);
  };

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

  const getTaskById = (uploadId: string) => state.tasks.find((item) => item.uploadId === uploadId);
  const getTaskByFingerprint = (fingerprint: string) =>
    state.tasks.find((item) => item.fingerprint === fingerprint);

  const ensureRuntime = (uploadId: string) => {
    let runtime = taskRuntimeMap.get(uploadId);
    if (!runtime) {
      runtime = { file: null, uploadPromise: null, controllers: new Map<number, AbortController>() };
      taskRuntimeMap.set(uploadId, runtime);
    }
    return runtime;
  };

  const abortRuntime = (runtime: TaskRuntime | undefined) => {
    if (!runtime) return;
    runtime.controllers.forEach((controller) => controller.abort());
    runtime.controllers.clear();
  };

  const touchTask = (task: LargeFileUploadTask) => {
    task.updatedAt = Date.now();
    schedulePersist();
    notify();
  };

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
    task.progress = resolveTaskProgressPercent(task, state.chunkLoadedBytesMap);
    touchTask(task);
  };

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

  const runTaskUpload = async (task: LargeFileUploadTask): Promise<string> => {
    const runtime = ensureRuntime(task.uploadId);
    if (runtime.uploadPromise) return runtime.uploadPromise;

    runtime.uploadPromise = (async () => {
      if (!runtime.file) {
        task.status = 'waiting_file';
        task.errorMessage = messages.waitingFile;
        touchTask(task);
        throw new Error(WAITING_FILE_ERROR);
      }
      if (!isOnline()) {
        task.status = 'paused';
        task.errorMessage = messages.offlinePause;
        touchTask(task);
        throw new Error(OFFLINE_ERROR);
      }

      task.status = 'uploading';
      task.errorMessage = '';
      touchTask(task);

      const statusRes = await options.api.status(task.uploadId, { skipDedupe: false });
      const statusPayload = resolveStatus(statusRes as StatusResponse);
      const uploadedSet = new Set<number>(normalizeChunkIndexes(statusPayload.uploadedChunks, task.totalChunks));
      updateTaskProgress(task, uploadedSet, null, true);

      const completedUrl = options.resolveUploadedUrl(statusPayload.fileInfo);
      if (statusPayload.completed && completedUrl) {
        finishTask(task.uploadId, completedUrl);
        return completedUrl;
      }

      const pendingIndexes: number[] = [];
      for (let i = 0; i < task.totalChunks; i += 1) {
        if (!uploadedSet.has(i)) pendingIndexes.push(i);
      }

      let cursor = 0;
      let fatalError: unknown = null;
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
      const workerCount = resolveConcurrency();

      const worker = async () => {
        while (true) {
          if (fatalError) return;
          const chunkIndex = pendingIndexes[cursor];
          cursor += 1;
          if (!Number.isFinite(chunkIndex)) return;

          for (let attempt = 0; attempt < retryTimes; attempt += 1) {
            if (!isOnline()) {
              fatalError = new Error(OFFLINE_ERROR);
              abortRuntime(runtime);
              return;
            }

            const start = chunkIndex * task.chunkSize;
            const end = Math.min(start + task.chunkSize, runtime.file!.size);
            const currentChunkSize = Math.max(0, end - start);
            const controller = new AbortController();
            runtime.controllers.set(chunkIndex, controller);

            try {
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
              break;
            } catch (error) {
              clearChunkLoadedBytes(task.uploadId, chunkIndex);
              const lastAttempt = attempt >= retryTimes - 1;
              const isConflictError = isChunkUploadConflictError(error);

              if (isConflictError) {
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
                    break;
                  }
                } catch {
                  // ignore status check failure and continue retry policy
                }
              }

              if (isAbortError(error) || (!isLikelyNetworkError(error) && !isConflictError) || lastAttempt) {
                fatalError = error;
                return;
              }
              await sleep((isConflictError ? 420 : 300) * (attempt + 1));
            } finally {
              runtime.controllers.delete(chunkIndex);
            }
          }
        }
      };

      await Promise.all(Array.from({ length: workerCount }, () => worker()));
      if (fatalError) throw fatalError;

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
            task.status = 'paused';
            task.errorMessage = messages.offlinePause;
          } else if (isAbortError(error) || isLikelyNetworkError(error)) {
            task.status = 'paused';
            task.errorMessage = messages.offlinePause;
          } else {
            task.status = 'failed';
            task.errorMessage = messages.uploadFailed;
          }
          touchTask(task);
        }
        throw error;
      })
      .finally(() => {
        runtime.uploadPromise = null;
      });

    return runtime.uploadPromise;
  };

  const upload = async (file: File): Promise<LargeFileUploadResult> => {
    const fingerprint =
      (await (options.buildFingerprint ? options.buildFingerprint(file) : buildFileFingerprint(file))) ||
      `${file.name}|${file.size}|${file.type}|${file.lastModified}`;
    const totalChunks = Math.max(1, Math.ceil(file.size / chunkSize));

    const initRes = await options.api.init({
      fileHash: fingerprint,
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type,
      chunkSize,
      totalChunks,
    });
    const initPayload = resolveInit(initRes as InitResponse);
    const uploadId = String(initPayload.uploadId || '').trim();
    if (!uploadId) throw new Error('Failed to initialize chunk upload.');

    const uploadTotalChunks = toInt(initPayload.totalChunks, totalChunks);
    const uploadChunkSize = toInt(initPayload.chunkSize, chunkSize);
    const uploadedChunkIndexes = normalizeChunkIndexes(initPayload.uploadedChunks, uploadTotalChunks);
    const oldTask = getTaskByFingerprint(fingerprint);
    if (oldTask && oldTask.uploadId !== uploadId) removeTask(oldTask.uploadId);

    let task = getTaskById(uploadId);
    if (!task) {
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

  const resume = async (uploadId: string) => {
    const task = getTaskById(uploadId);
    if (!task) return false;
    try {
      await runTaskUpload(task);
      return true;
    } catch {
      return false;
    }
  };

  const pauseAll = () => {
    let touched = false;
    state.tasks.forEach((task) => {
      if (task.status !== 'uploading') return;
      task.status = 'paused';
      task.errorMessage = messages.offlinePause;
      task.updatedAt = Date.now();
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

  const resumePaused = () => {
    if (!isOnline()) return;
    state.tasks.forEach((task) => {
      if (task.status !== 'paused') return;
      const runtime = taskRuntimeMap.get(task.uploadId);
      if (!runtime?.file) return;
      void runTaskUpload(task).catch(() => {});
    });
  };

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
    remove: removeTask,
    pauseAll,
    resumePaused,
    dispose,
    getTaskById,
    getTaskByFingerprint,
  };
};
