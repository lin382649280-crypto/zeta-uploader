# ZetaUploader

一个专注于**大文件分片上传、断点续传与任务管理**的轻量级上传管理器。无 UI 依赖，可用于 Vue/React/原生项目。

---

## 特性亮点

- **分片上传**：大文件分片传输，降低失败率与单次请求体积
- **断点续传**：刷新页面或网络中断后可恢复
- **任务持久化**：支持 localStorage / 自定义存储
- **并发上传**：可设置并发数量，支持自适应并发
- **稳定重试**：指数退避 + 抖动，避免重试风暴
- **进度节流**：避免频繁刷新 UI 导致卡顿
- **事件回调**：任务状态、进度、错误、分片事件可监听

---

## 安装

```bash
npm i @wangyuanlin/zeta-uploader
```

---

## 快速使用

```ts
import { createLargeFileUploadManager } from '@wangyuanlin/zeta-uploader';

const uploader = createLargeFileUploadManager({
  api: {
    init: (payload) => apiInit(payload),
    status: (uploadId, options) => apiStatus(uploadId, options),
    uploadChunk: (payload, options) => apiUploadChunk(payload, options),
    complete: (uploadId) => apiComplete(uploadId),
  },
  resolveInitResponse: (res) => res.data,
  resolveStatusResponse: (res) => res.data,
  resolveCompleteResponse: (res) => res.data,
  resolveUploadedUrl: (fileInfo, fallback) => fileInfo?.url || String(fallback || ''),
  storageKey: 'zeta-upload:tasks',
});

uploader.subscribe((state) => {
  console.log('tasks:', state.tasks);
});
```

---

## 核心概念

- **任务（Task）**：一次上传流程的状态描述，包括进度、失败原因等
- **分片（Chunk）**：文件被切分后的片段，每片独立上传
- **指纹（Fingerprint）**：用来标识同一文件，支持断点续传

---

## API 一览

### 创建管理器

```ts
const uploader = createLargeFileUploadManager(options);
```

### 基础方法

- `upload(file)` 开始上传文件
- `resume(uploadId, file?)` 继续上传（可重新传入 file 绑定）
- `pause(uploadId)` 暂停单个任务
- `pauseAll()` 暂停所有任务
- `resumePaused()` 恢复所有暂停任务
- `remove(uploadId)` 删除任务
- `dispose()` 释放资源
- `getState()` 获取当前状态快照
- `subscribe(listener)` 订阅状态变化
- `getTaskById(uploadId)` 通过 ID 获取任务
- `getTaskByFingerprint(fingerprint)` 通过指纹获取任务

---

## 详细配置（options）

### 必填

- `api`: 分片上传 API 实现
- `resolveUploadedUrl`: 从服务端返回中解析最终 URL

### 可选（常用）

- `chunkSize`: number | (file) => number
  - 分片大小（字节），可按文件动态决定
- `chunkConcurrency`: number | (file) => number
  - 并发上传数量
- `retryTimes`: number
  - 每个分片最大重试次数
- `storage` / `storageKey`
  - 持久化存储设置
- `messages`
  - 自定义提示文案

### 进阶稳定性

- `adaptiveConcurrency`: boolean | {
  min, max, increaseStep, decreaseStep, windowSize, successThreshold, failureThreshold
}
  - 根据成功/失败动态调整并发

- `retryBaseDelayMs` / `retryMaxDelayMs` / `retryJitterRatio`
  - 退避策略，避免雪崩式重试

- `shouldRetry(context)`
  - 自定义是否重试

- `resolveRetryDelayMs(context)`
  - 自定义重试等待时间

### 进度性能优化

- `progressIntervalMs`: number
  - 进度回调最小时间间隔
- `progressDeltaPercent`: number
  - 进度回调最小变化阈值

---

## 事件回调

- `onTaskStart(task, file)`
- `onTaskProgress(task, progress, uploadedBytes, totalBytes)`
- `onTaskStatusChange(task, prevStatus, nextStatus)`
- `onTaskError(task, error)`
- `onChunkSuccess(task, chunkIndex)`
- `onChunkError(task, chunkIndex, error, attempt)`
- `onTaskComplete(task, url, file)`

---

## 断点续传示例

```ts
// 当用户重新选择同一个文件时
await uploader.resume(task.uploadId, file);
```

如果文件指纹不同，会进入 `waiting_file` 状态并提示重新选择正确文件。

---

## 常见问题（FAQ）

### 1. 为什么上传失败后进入 paused？
网络波动或离线时会自动暂停，等待恢复后可调用 `resumePaused()`。

### 2. 为什么 progress 没有实时变化？
默认启用了进度节流（`progressIntervalMs` / `progressDeltaPercent`），可调小或设为 `0`。

### 3. 如何控制并发更稳定？
使用 `adaptiveConcurrency`，遇到失败自动降低并发，稳定后自动提升。

---

## License

MIT
