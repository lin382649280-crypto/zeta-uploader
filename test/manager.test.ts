import { describe, expect, it } from 'vitest';
import { createLargeFileUploadManager } from '../src/large-file-upload';

const createAbortError = () => ({ name: 'AbortError', message: 'canceled' });

const createMockApi = (chunkSize: number) => {
  const uploadedChunks = new Set<number>();
  const uploadResolvers: Array<() => void> = [];
  const uploadRejectors: Array<(error: unknown) => void> = [];
  const uploadId = 'upload-1';

  return {
    uploadResolvers,
    uploadRejectors,
    api: {
      init: async (payload: { totalChunks: number }) => ({
        uploadId,
        totalChunks: payload.totalChunks,
        chunkSize,
        uploadedChunks: Array.from(uploadedChunks),
      }),
      status: async () => ({
        uploadId,
        uploadedChunks: Array.from(uploadedChunks),
        completed: uploadedChunks.size > 0 && uploadedChunks.size === 2,
      }),
      uploadChunk: async (payload: { chunkIndex: number }, options?: { signal?: AbortSignal }) =>
        new Promise<void>((resolve, reject) => {
          const index = payload.chunkIndex;
          const onAbort = () => reject(createAbortError());
          if (options?.signal) {
            if (options.signal.aborted) {
              reject(createAbortError());
              return;
            }
            options.signal.addEventListener('abort', onAbort, { once: true });
          }
          uploadResolvers.push(() => {
            options?.signal?.removeEventListener('abort', onAbort);
            uploadedChunks.add(index);
            resolve();
          });
          uploadRejectors.push(reject);
        }),
      complete: async () => ({ fileInfo: { url: 'https://example.com/file.bin' } }),
    },
  };
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('ZetaUploader manager', () => {
  it('pauses a task manually without overwriting message', async () => {
    const chunkSize = 2;
    const { api } = createMockApi(chunkSize);
    const manager = createLargeFileUploadManager({
      api,
      chunkSize,
      chunkConcurrency: 1,
      retryTimes: 1,
      messages: {
        manualPause: 'Paused by user',
      },
      resolveUploadedUrl: (fileInfo) => fileInfo?.url || '',
    });

    const file = new File([new Uint8Array([1, 2, 3, 4])], 'demo.bin');
    const uploadPromise = manager.upload(file);
    await flush();

    const task = manager.getState().tasks[0];
    expect(task).toBeTruthy();

    manager.pause(task.uploadId);
    const pausedTask = manager.getTaskById(task.uploadId);
    expect(pausedTask?.status).toBe('paused');
    expect(pausedTask?.errorMessage).toBe('Paused by user');

    await expect(uploadPromise).rejects.toBeTruthy();
  });

  it('emits progress and completes upload', async () => {
    const chunkSize = 2;
    const { api, uploadResolvers } = createMockApi(chunkSize);
    const progressEvents: number[] = [];
    const manager = createLargeFileUploadManager({
      api,
      chunkSize,
      chunkConcurrency: 1,
      retryTimes: 1,
      progressIntervalMs: 0,
      progressDeltaPercent: 0,
      resolveUploadedUrl: (fileInfo) => fileInfo?.url || '',
      onTaskProgress: (task) => {
        progressEvents.push(task.progress ?? 0);
      },
    });

    const file = new File([new Uint8Array([1, 2, 3, 4])], 'demo.bin');
    const uploadPromise = manager.upload(file);
    await flush();

    expect(uploadResolvers.length).toBe(1);
    uploadResolvers.shift()?.();
    await flush();

    expect(progressEvents.some((value) => value >= 50)).toBe(true);

    expect(uploadResolvers.length).toBe(1);
    uploadResolvers.shift()?.();

    const result = await uploadPromise;
    expect(result.url).toBe('https://example.com/file.bin');
    expect(progressEvents.some((value) => value >= 100)).toBe(true);
  });
});
