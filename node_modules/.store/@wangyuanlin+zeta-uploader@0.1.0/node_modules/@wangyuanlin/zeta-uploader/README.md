# Large File Upload Manager

专注于大文件分片上传、断点续传与任务恢复的核心管理器。无 UI 依赖，可用于 Vue/React/原生项目。

## 安装

```bash
npm i @wangyuanlin/zeta-uploader
```
## 快速使用

```ts
import { createLargeFileUploadManager } from 'lincode-large-file-upload';
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
  storageKey: 'large-upload:tasks',
});

uploader.subscribe((state) => {
  console.log(state.tasks);
});
```

## 设计要点

- 分片上传 + 冲突恢复（409 重新校准）
- 断网自动暂停，恢复后继续上传
- 任务持久化，刷新页面可继续

## 主要 API

- `createLargeFileUploadManager(options)` 创建管理器
- `upload(file)` 开始上传
- `resume(uploadId)` 继续上传
- `remove(uploadId)` 删除任务
- `pauseAll()` 暂停所有任务
- `resumePaused()` 恢复暂停任务
- `subscribe(listener)` 订阅状态变更

