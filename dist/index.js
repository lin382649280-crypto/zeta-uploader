// src/constants.ts
var DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;
var DEFAULT_CHUNK_CONCURRENCY = 4;
var DEFAULT_RETRY_TIMES = 3;
var DEFAULT_RETRY_BASE_DELAY_MS = 300;
var DEFAULT_RETRY_MAX_DELAY_MS = 5e3;
var DEFAULT_RETRY_JITTER_RATIO = 0.2;
var DEFAULT_TASK_CACHE_LIMIT = 16;
var CHUNK_PROGRESS_FLUSH_INTERVAL_MS = 120;
var DEFAULT_PROGRESS_INTERVAL_MS = 200;
var DEFAULT_PROGRESS_DELTA_PERCENT = 1;
var FINGERPRINT_SAMPLE_BYTES = 1024 * 1024;
var WAITING_FILE_ERROR = "WAITING_FILE";
var OFFLINE_ERROR = "UPLOAD_OFFLINE";
var DEFAULT_STORAGE_KEY = "large-file-upload:tasks:v1";
var DEFAULT_MESSAGES = {
  waitingFile: "Please reselect the same file to resume upload.",
  offlinePause: "Network disconnected, upload paused.",
  manualPause: "Upload paused.",
  uploadFailed: "Upload failed, please retry.",
  restoredWaitingFile: "Upload progress restored, please reselect the same file to continue.",
  missingUrl: "Upload succeeded but returned URL is missing."
};

// src/utils/number.ts
var toInt = (value, fallback = 0) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.floor(parsed);
};
var clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// src/utils/env.ts
var resolvePreferredChunkConcurrency = () => {
  if (typeof navigator === "undefined") return DEFAULT_CHUNK_CONCURRENCY;
  const cores = Math.max(1, Number(navigator.hardwareConcurrency || 4));
  if (cores <= 4) return 2;
  if (cores <= 8) return 3;
  return DEFAULT_CHUNK_CONCURRENCY;
};
var resolveDefaultIsOnline = () => typeof navigator === "undefined" ? true : navigator.onLine;

// src/utils/time.ts
var sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

// src/utils/error.ts
var resolveErrorStatus = (error) => {
  const source = error;
  return Number(source.response?.status || source.statusCode || source.response?.data?.code || 0);
};
var isAbortError = (error) => {
  const source = error;
  const code = String(source.code || "").toUpperCase();
  if (code === "ERR_CANCELED") return true;
  const name = String(source.name || "").toLowerCase();
  if (name === "cancelederror" || name === "aborterror") return true;
  return String(source.message || "").toLowerCase().includes("canceled");
};
var isLikelyNetworkError = (error) => {
  const source = error;
  if (source.response) return false;
  const code = String(source.code || "").toUpperCase();
  if (["ERR_NETWORK", "ECONNABORTED", "ETIMEDOUT", "ENOTFOUND", "ECONNRESET"].includes(code)) return true;
  const message = String(source.message || "").toLowerCase();
  return message.includes("network") || message.includes("timeout") || message.includes("failed to fetch");
};
var isChunkUploadConflictError = (error) => resolveErrorStatus(error) === 409;
var isRetryableStatus = (status) => status === 408 || status === 429 || status >= 500 && status < 600;
var isRetryableError = (error) => isLikelyNetworkError(error) || isRetryableStatus(resolveErrorStatus(error));

// src/utils/chunk.ts
var normalizeChunkIndexes = (raw, totalChunks) => {
  if (!Array.isArray(raw)) return [];
  return Array.from(
    new Set(
      raw.map((item) => toInt(item, -1)).filter((index) => index >= 0 && index < totalChunks).sort((a, b) => a - b)
    )
  );
};
var resolveChunkByteSize = (task, chunkIndex) => {
  if (chunkIndex < 0 || chunkIndex >= task.totalChunks) return 0;
  if (chunkIndex === task.totalChunks - 1) {
    const remaining = task.fileSize - task.chunkSize * (task.totalChunks - 1);
    return Math.max(0, remaining);
  }
  return Math.max(0, task.chunkSize);
};

// src/utils/progress.ts
var resolveTaskUploadedBytes = (task, chunkLoadedBytesMap) => {
  const uploadedSet = new Set(task.uploadedChunkIndexes || []);
  let bytes = 0;
  uploadedSet.forEach((chunkIndex) => {
    bytes += resolveChunkByteSize(task, chunkIndex);
  });
  const prefix = `${task.uploadId}:`;
  Object.entries(chunkLoadedBytesMap).forEach(([key, loaded]) => {
    if (!key.startsWith(prefix)) return;
    const chunkIndex = Number(key.slice(prefix.length));
    if (!Number.isFinite(chunkIndex) || uploadedSet.has(chunkIndex)) return;
    bytes += Math.min(Math.max(0, Number(loaded || 0)), resolveChunkByteSize(task, chunkIndex));
  });
  return Math.min(Math.max(0, task.fileSize), Math.max(0, bytes));
};
var resolveTaskProgressPercent = (task, chunkLoadedBytesMap) => {
  const total = Math.max(1, Number(task.fileSize || 0));
  return Math.min(100, Math.floor(resolveTaskUploadedBytes(task, chunkLoadedBytesMap) / total * 100));
};
var resolveOverallProgress = (tasks, chunkLoadedBytesMap) => {
  if (!tasks.length) return 0;
  const totalBytes = tasks.reduce((sum, task) => sum + Math.max(0, Number(task.fileSize || 0)), 0);
  if (!totalBytes) return 0;
  const uploadedBytes = tasks.reduce((sum, task) => sum + resolveTaskUploadedBytes(task, chunkLoadedBytesMap), 0);
  return Math.min(100, Math.floor(uploadedBytes / totalBytes * 100));
};

// src/utils/fingerprint.ts
var toHex = (buffer) => Array.from(new Uint8Array(buffer)).map((item) => item.toString(16).padStart(2, "0")).join("");
var buildFileFingerprint = async (file) => {
  const fallback = `${file.name}|${file.size}|${file.type}|${file.lastModified}`;
  const subtle = typeof globalThis !== "undefined" ? globalThis.crypto?.subtle : void 0;
  if (!subtle || typeof TextEncoder === "undefined") return fallback;
  try {
    const sample = Math.min(FINGERPRINT_SAMPLE_BYTES, file.size);
    const middleStart = Math.max(0, Math.floor(file.size / 2) - Math.floor(sample / 2));
    const parts = [
      new TextEncoder().encode(fallback),
      new Uint8Array(await file.slice(0, sample).arrayBuffer()),
      new Uint8Array(await file.slice(middleStart, middleStart + sample).arrayBuffer()),
      new Uint8Array(await file.slice(Math.max(0, file.size - sample), file.size).arrayBuffer())
    ];
    const mergedLength = parts.reduce((sum, item) => sum + item.length, 0);
    const merged = new Uint8Array(mergedLength);
    let offset = 0;
    parts.forEach((item) => {
      merged.set(item, offset);
      offset += item.length;
    });
    const digest = await subtle.digest("SHA-256", merged);
    return toHex(digest);
  } catch {
    return fallback;
  }
};

// src/storage/browser-storage.ts
var createBrowserStorage = () => {
  if (typeof window === "undefined" || !window.localStorage) return null;
  return {
    get: (key) => {
      try {
        const raw = window.localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    },
    set: (key, value) => {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
      } catch {
      }
    },
    remove: (key) => {
      try {
        window.localStorage.removeItem(key);
      } catch {
      }
    }
  };
};

// src/utils/array.ts
var insertSortedUnique = (sorted, value) => {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = low + high >> 1;
    if (sorted[mid] < value) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  if (sorted[low] !== value) {
    sorted.splice(low, 0, value);
  }
  return sorted;
};

// src/utils/retry.ts
var resolveRetryDelayMs = (context, options) => {
  if (options.customResolver) {
    const customValue = options.customResolver(context);
    if (Number.isFinite(customValue) && customValue >= 0) {
      return Math.floor(customValue);
    }
  }
  const base = Math.max(0, options.baseDelayMs);
  const max = Math.max(base, options.maxDelayMs);
  const expDelay = Math.min(max, base * 2 ** Math.max(0, context.attempt));
  const jitterRatio = Math.max(0, Math.min(1, options.jitterRatio));
  if (!jitterRatio) return Math.floor(expDelay);
  const jitter = expDelay * jitterRatio;
  const offset = (Math.random() * 2 - 1) * jitter;
  return Math.max(0, Math.floor(expDelay + offset));
};

// src/utils/format.ts
var formatFileSize = (size) => {
  const safeSize = Number(size || 0);
  if (safeSize <= 0) return "0 B";
  if (safeSize < 1024) return `${safeSize} B`;
  if (safeSize < 1024 * 1024) return `${(safeSize / 1024).toFixed(1)} KB`;
  if (safeSize < 1024 * 1024 * 1024) return `${(safeSize / (1024 * 1024)).toFixed(1)} MB`;
  return `${(safeSize / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

// src/large-file-upload.ts
var createLargeFileUploadManager = (options) => {
  const messages = { ...DEFAULT_MESSAGES, ...options.messages || {} };
  const storage = options.storage ?? createBrowserStorage();
  const storageKey = String(options.storageKey || DEFAULT_STORAGE_KEY);
  const taskCacheLimit = Math.max(1, toInt(options.taskCacheLimit, DEFAULT_TASK_CACHE_LIMIT));
  const defaultChunkSize = Math.max(
    1,
    toInt(typeof options.chunkSize === "number" ? options.chunkSize : DEFAULT_CHUNK_SIZE, DEFAULT_CHUNK_SIZE)
  );
  const resolveChunkSize = (file) => {
    if (typeof options.chunkSize === "function") {
      return Math.max(1, toInt(options.chunkSize(file), defaultChunkSize));
    }
    return defaultChunkSize;
  };
  const retryTimes = clamp(toInt(options.retryTimes, DEFAULT_RETRY_TIMES), 1, 12);
  const retryBaseDelayMs = Math.max(0, toInt(options.retryBaseDelayMs, DEFAULT_RETRY_BASE_DELAY_MS));
  const retryMaxDelayMs = Math.max(retryBaseDelayMs, toInt(options.retryMaxDelayMs, DEFAULT_RETRY_MAX_DELAY_MS));
  const retryJitterRatio = clamp(
    Number.isFinite(options.retryJitterRatio) ? Number(options.retryJitterRatio) : DEFAULT_RETRY_JITTER_RATIO,
    0,
    1
  );
  const progressIntervalMs = Math.max(0, toInt(options.progressIntervalMs, DEFAULT_PROGRESS_INTERVAL_MS));
  const progressDeltaPercent = clamp(
    Number.isFinite(options.progressDeltaPercent) ? Number(options.progressDeltaPercent) : DEFAULT_PROGRESS_DELTA_PERCENT,
    0,
    100
  );
  const resolveInit = options.resolveInitResponse ?? ((res) => res);
  const resolveStatus = options.resolveStatusResponse ?? ((res) => res);
  const resolveComplete = options.resolveCompleteResponse ?? ((res) => res);
  const isOnline = options.isOnline ?? resolveDefaultIsOnline;
  const onTaskComplete = options.onTaskComplete;
  const onTaskStart = options.onTaskStart;
  const onTaskProgress = options.onTaskProgress;
  const onTaskStatusChange = options.onTaskStatusChange;
  const onTaskError = options.onTaskError;
  const onChunkSuccess = options.onChunkSuccess;
  const onChunkError = options.onChunkError;
  let disposed = false;
  const state = {
    tasks: [],
    chunkLoadedBytesMap: {}
  };
  const listeners = /* @__PURE__ */ new Set();
  const taskRuntimeMap = /* @__PURE__ */ new Map();
  const pendingChunkLoadedUpdates = /* @__PURE__ */ new Map();
  let persistTimer = null;
  let chunkProgressFlushTimer = null;
  const getSnapshot = () => ({
    tasks: [...state.tasks],
    chunkLoadedBytesMap: { ...state.chunkLoadedBytesMap }
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
    const touchedTaskIds = /* @__PURE__ */ new Set();
    const nextMap = { ...state.chunkLoadedBytesMap };
    pendingChunkLoadedUpdates.forEach((value, key) => {
      const separatorIndex = key.indexOf(":");
      if (separatorIndex > 0) touchedTaskIds.add(key.slice(0, separatorIndex));
      if (value === null) {
        delete nextMap[key];
      } else {
        nextMap[key] = value;
      }
    });
    pendingChunkLoadedUpdates.clear();
    state.chunkLoadedBytesMap = nextMap;
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
  const setChunkLoadedBytes = (uploadId, chunkIndex, loadedBytes) => {
    const key = `${uploadId}:${chunkIndex}`;
    const safeLoaded = Math.max(0, Math.floor(Number(loadedBytes || 0)));
    if (pendingChunkLoadedUpdates.get(key) === safeLoaded) return;
    pendingChunkLoadedUpdates.set(key, safeLoaded);
    scheduleChunkProgressFlush(false);
  };
  const clearChunkLoadedBytes = (uploadId, chunkIndex) => {
    const key = `${uploadId}:${chunkIndex}`;
    if (pendingChunkLoadedUpdates.get(key) === null) return;
    pendingChunkLoadedUpdates.set(key, null);
    scheduleChunkProgressFlush(true);
  };
  const clearTaskChunkLoadedBytes = (uploadId) => {
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
  const getTaskById = (uploadId) => state.tasks.find((item) => item.uploadId === uploadId);
  const getTaskByFingerprint = (fingerprint) => state.tasks.find((item) => item.fingerprint === fingerprint);
  const ensureRuntime = (uploadId) => {
    let runtime = taskRuntimeMap.get(uploadId);
    if (!runtime) {
      runtime = {
        file: null,
        uploadPromise: null,
        controllers: /* @__PURE__ */ new Map(),
        lastProgressAt: 0,
        lastProgressValue: -1
      };
      taskRuntimeMap.set(uploadId, runtime);
    }
    return runtime;
  };
  const abortRuntime = (runtime) => {
    if (!runtime) return;
    runtime.controllers.forEach((controller) => controller.abort());
    runtime.controllers.clear();
  };
  const touchTask = (task, options2) => {
    const notifyEnabled = options2?.notify ?? true;
    const persistEnabled = options2?.persist ?? true;
    const updateTimestamp = options2?.updateTimestamp ?? true;
    if (updateTimestamp) {
      task.updatedAt = Date.now();
    }
    if (persistEnabled) schedulePersist();
    if (notifyEnabled) notify();
  };
  const setTaskStatus = (task, status, message = "", options2) => {
    const prevStatus = task.status;
    task.status = status;
    task.errorMessage = message;
    touchTask(task, { notify: options2?.notify ?? true });
    if (prevStatus !== status && onTaskStatusChange) {
      onTaskStatusChange(task, prevStatus, status);
    }
  };
  const shouldEmitProgress = (uploadId, nextProgress) => {
    const runtime = ensureRuntime(uploadId);
    if (nextProgress >= 100) return true;
    if (runtime.lastProgressValue < 0) return true;
    const now = Date.now();
    if (progressIntervalMs > 0 && now - runtime.lastProgressAt >= progressIntervalMs) return true;
    if (progressDeltaPercent <= 0) return true;
    return Math.abs(nextProgress - runtime.lastProgressValue) >= progressDeltaPercent;
  };
  const markProgressEmitted = (uploadId, progress) => {
    const runtime = ensureRuntime(uploadId);
    runtime.lastProgressAt = Date.now();
    runtime.lastProgressValue = progress;
  };
  const updateTaskProgress = (task, uploadedSet, changedIndex, replaceAll = false) => {
    if (replaceAll || changedIndex === null || changedIndex === void 0) {
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
      touchTask(task, { notify: false, updateTimestamp: false });
    }
  };
  const removeTask = (uploadId) => {
    const index = state.tasks.findIndex((item) => item.uploadId === uploadId);
    if (index >= 0) state.tasks.splice(index, 1);
    const runtime = taskRuntimeMap.get(uploadId);
    abortRuntime(runtime);
    taskRuntimeMap.delete(uploadId);
    clearTaskChunkLoadedBytes(uploadId);
    schedulePersist();
    notify();
  };
  const finishTask = (uploadId, url) => {
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
  const runTaskUpload = async (task) => {
    const runtime = ensureRuntime(task.uploadId);
    if (runtime.uploadPromise) return runtime.uploadPromise;
    runtime.uploadPromise = (async () => {
      if (!runtime.file) {
        setTaskStatus(task, "waiting_file", messages.waitingFile);
        throw new Error(WAITING_FILE_ERROR);
      }
      if (!isOnline()) {
        setTaskStatus(task, "paused", messages.offlinePause);
        throw new Error(OFFLINE_ERROR);
      }
      setTaskStatus(task, "uploading", "");
      if (onTaskStart) {
        onTaskStart(task, runtime.file);
      }
      const statusRes = await options.api.status(task.uploadId, { skipDedupe: false });
      const statusPayload = resolveStatus(statusRes);
      const uploadedSet = new Set(normalizeChunkIndexes(statusPayload.uploadedChunks, task.totalChunks));
      updateTaskProgress(task, uploadedSet, null, true);
      const completedUrl = options.resolveUploadedUrl(statusPayload.fileInfo);
      if (statusPayload.completed && completedUrl) {
        finishTask(task.uploadId, completedUrl);
        return completedUrl;
      }
      const pendingIndexes = [];
      for (let i = 0; i < task.totalChunks; i += 1) {
        if (!uploadedSet.has(i)) pendingIndexes.push(i);
      }
      let cursor = 0;
      let fatalError = null;
      const resolveConcurrency = () => {
        if (!pendingIndexes.length) return 1;
        if (typeof options.chunkConcurrency === "function") {
          return clamp(options.chunkConcurrency(runtime.file), 1, pendingIndexes.length);
        }
        if (typeof options.chunkConcurrency === "number") {
          return clamp(options.chunkConcurrency, 1, pendingIndexes.length);
        }
        return Math.max(1, Math.min(resolvePreferredChunkConcurrency(), pendingIndexes.length));
      };
      const baseConcurrency = resolveConcurrency();
      const adaptiveInput = options.adaptiveConcurrency;
      const adaptive = adaptiveInput === void 0 || adaptiveInput === false ? { enabled: false } : adaptiveInput === true ? { enabled: true } : { enabled: true, ...adaptiveInput };
      const adaptiveMin = clamp(toInt(adaptive.min, 1), 1, pendingIndexes.length || 1);
      const adaptiveMax = clamp(toInt(adaptive.max, baseConcurrency), adaptiveMin, pendingIndexes.length || 1);
      const adaptiveIncrease = clamp(toInt(adaptive.increaseStep, 1), 1, pendingIndexes.length || 1);
      const adaptiveDecrease = clamp(toInt(adaptive.decreaseStep, 1), 1, pendingIndexes.length || 1);
      const adaptiveWindow = clamp(toInt(adaptive.windowSize, 6), 2, 20);
      const adaptiveSuccessThreshold = clamp(toInt(adaptive.successThreshold, 4), 1, adaptiveWindow);
      const adaptiveFailureThreshold = clamp(toInt(adaptive.failureThreshold, 2), 1, adaptiveWindow);
      let maxConcurrent = adaptive.enabled ? clamp(baseConcurrency, adaptiveMin, adaptiveMax) : baseConcurrency;
      const adaptiveOutcomes = [];
      const recordOutcome = (ok) => {
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
      const shouldRetry = options.shouldRetry ?? ((context) => context.isConflictError || isRetryableError(context.error));
      const processChunk = async (chunkIndex) => {
        for (let attempt = 0; attempt < retryTimes; attempt += 1) {
          if (!isOnline()) {
            throw new Error(OFFLINE_ERROR);
          }
          const start = chunkIndex * task.chunkSize;
          const end = Math.min(start + task.chunkSize, runtime.file.size);
          const currentChunkSize = Math.max(0, end - start);
          const controller = new AbortController();
          runtime.controllers.set(chunkIndex, controller);
          try {
            await options.api.uploadChunk(
              {
                uploadId: task.uploadId,
                chunkIndex,
                totalChunks: task.totalChunks,
                chunk: runtime.file.slice(start, end)
              },
              {
                signal: controller.signal,
                onProgress: (loaded) => {
                  const safeLoaded = Math.min(Number(loaded || 0), currentChunkSize);
                  setChunkLoadedBytes(task.uploadId, chunkIndex, safeLoaded);
                }
              }
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
              try {
                const statusRes2 = await options.api.status(task.uploadId, { skipDedupe: true });
                const statusPayload2 = resolveStatus(statusRes2);
                const latestUploaded = normalizeChunkIndexes(statusPayload2.uploadedChunks, task.totalChunks);
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
              }
            }
            const context = {
              error,
              attempt,
              maxAttempts: retryTimes,
              isLastAttempt: attempt >= retryTimes - 1,
              statusCode: resolveErrorStatus(error),
              isNetworkError: isLikelyNetworkError(error),
              isConflictError
            };
            if (onChunkError) onChunkError(task, chunkIndex, error, attempt + 1);
            if (isAbortError(error) || context.isLastAttempt || !shouldRetry(context)) {
              throw error;
            }
            const delay = resolveRetryDelayMs(context, {
              baseDelayMs: retryBaseDelayMs,
              maxDelayMs: retryMaxDelayMs,
              jitterRatio: retryJitterRatio,
              customResolver: options.resolveRetryDelayMs
            });
            await sleep(delay);
          } finally {
            runtime.controllers.delete(chunkIndex);
          }
        }
      };
      const runQueue = async () => new Promise((resolve, reject) => {
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
            void processChunk(chunkIndex).then(() => {
              recordOutcome(true);
              active -= 1;
              if (cursor >= pendingIndexes.length && active === 0) {
                resolve();
                return;
              }
              launchNext();
            }).catch((error) => {
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
      const completeRes = await options.api.complete(task.uploadId);
      const completePayload = resolveComplete(completeRes);
      const finalUrl = options.resolveUploadedUrl(completePayload.fileInfo, completePayload.files?.[0]?.url);
      if (!finalUrl) throw new Error(messages.missingUrl);
      finishTask(task.uploadId, finalUrl);
      return finalUrl;
    })().catch((error) => {
      if (!(error instanceof Error && error.message === WAITING_FILE_ERROR)) {
        if (error instanceof Error && error.message === OFFLINE_ERROR) {
          setTaskStatus(task, "paused", messages.offlinePause);
        } else if (isAbortError(error) || isLikelyNetworkError(error)) {
          if (task.status !== "paused") {
            setTaskStatus(task, "paused", messages.offlinePause);
          }
        } else {
          setTaskStatus(task, "failed", messages.uploadFailed);
          if (onTaskError) onTaskError(task, error);
        }
      }
      throw error;
    }).finally(() => {
      runtime.uploadPromise = null;
    });
    return runtime.uploadPromise;
  };
  const upload = async (file) => {
    const fingerprint = await (options.buildFingerprint ? options.buildFingerprint(file) : buildFileFingerprint(file)) || `${file.name}|${file.size}|${file.type}|${file.lastModified}`;
    const resolvedChunkSize = resolveChunkSize(file);
    const totalChunks = Math.max(1, Math.ceil(file.size / resolvedChunkSize));
    const initRes = await options.api.init({
      fileHash: fingerprint,
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type,
      chunkSize: resolvedChunkSize,
      totalChunks
    });
    const initPayload = resolveInit(initRes);
    const uploadId = String(initPayload.uploadId || "").trim();
    if (!uploadId) throw new Error("Failed to initialize chunk upload.");
    const uploadTotalChunks = toInt(initPayload.totalChunks, totalChunks);
    const uploadChunkSize = toInt(initPayload.chunkSize, resolvedChunkSize);
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
        status: "uploading",
        errorMessage: "",
        updatedAt: Date.now()
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
      task.status = "uploading";
      task.errorMessage = "";
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
  const resume = async (uploadId, file) => {
    const task = getTaskById(uploadId);
    if (!task) return false;
    if (file) {
      const fingerprint = await (options.buildFingerprint ? options.buildFingerprint(file) : buildFileFingerprint(file)) || `${file.name}|${file.size}|${file.type}|${file.lastModified}`;
      if (task.fingerprint && fingerprint !== task.fingerprint) {
        setTaskStatus(task, "waiting_file", messages.waitingFile);
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
  const pause = (uploadId) => {
    const task = getTaskById(uploadId);
    if (!task) return;
    if (task.status === "uploading") {
      setTaskStatus(task, "paused", messages.manualPause);
    }
    const runtime = taskRuntimeMap.get(uploadId);
    abortRuntime(runtime);
    clearTaskChunkLoadedBytes(uploadId);
  };
  const pauseAll = () => {
    let touched = false;
    state.tasks.forEach((task) => {
      if (task.status !== "uploading") return;
      setTaskStatus(task, "paused", messages.offlinePause, { notify: false });
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
      if (task.status !== "paused") return;
      const runtime = taskRuntimeMap.get(task.uploadId);
      if (!runtime?.file) return;
      void runTaskUpload(task).catch(() => {
      });
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
    const cached = storage.get(storageKey);
    if (!Array.isArray(cached) || !cached.length) return;
    state.tasks = cached.slice(0, taskCacheLimit).map((item) => {
      const totalChunks = Math.max(1, toInt(item.totalChunks, 1));
      const uploaded = normalizeChunkIndexes(item.uploadedChunkIndexes, totalChunks);
      const task = {
        ...item,
        totalChunks,
        uploadedChunkIndexes: uploaded,
        status: "waiting_file",
        errorMessage: messages.restoredWaitingFile
      };
      task.progress = resolveTaskProgressPercent(task, state.chunkLoadedBytesMap);
      return task;
    }).filter((item) => item.uploadId && item.fingerprint);
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
    pause,
    remove: removeTask,
    pauseAll,
    resumePaused,
    dispose,
    getTaskById,
    getTaskByFingerprint
  };
};
export {
  buildFileFingerprint,
  createLargeFileUploadManager,
  formatFileSize,
  resolveOverallProgress,
  resolveTaskProgressPercent,
  resolveTaskUploadedBytes
};
