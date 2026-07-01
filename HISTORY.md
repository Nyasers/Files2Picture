# 更新日志

## 2026-07-01

### 下载派发重构

- **去掉 iframe + POST 表单**：`postViaIframe` → `triggerDownload`（隐藏 `<a>` + `click`）
- **REST 路径**：`POST /dl`（formData）→ `GET /files?id=xxx[&idx=n]` + `GET /file/<hash>/<filename>`
- **302 重定向**：`/files` 只做查询和跳转，`/file/` 只做流式响应，职责分离
- **hash 派生**：`SHA1(id[+idx])` 唯一确定文件，路径不挂 idx
- **批量串行化**：循环中 `await waitForJobStart`，等 SW 回 `job-start` 信号再触发下一个，消除导航抢占
- **Content-Disposition 简化**：只写 `attachment` 不写 `filename`，浏览器从 URL 末尾取保存名
- **清理`download`属性**：回归导航式下载，不依赖 `<a download>`

### 握手简化 + 增量渲染

- 编码：`encode-stream-prepare` / `encode-stream-ready` 独立握手合并入 `encode` 消息，SW 同步设 pendingStreams 后立即回复 ready，再异步跑 runEncode
- 解码单文件：`handleDecodeStreamPrepare` 改为同步设 pending 条目，`crypto.subtle.importKey` 的 Promise 存入 `keyPromise`，fetch handler 推迟 await
- 解码批量：同上，`keyPromise` 延迟到 fetch handler
- 解码流中 `readBmpHeader` 移出循环体，每 chunk 不再重复解析 BMP 头
- 任务列表改为增量 DOM 更新，不再全量 `innerHTML` 重绘

### 编码流等待 Promise 化 + 解码器自包含

- `runEncode` 等 `pc.push` 从 5ms 轮询改为 Promise 桥接，ReadableStream `start` 回调完成时 resolve，消除竞态隐患
- `decMetaStream` 从 `f2p-core.js` 移除，元数据解析内联进各解码器自身：
  - `f2p1-decode` / `f2p2-decode` / `f2p3-decode` / `f2p4-decode` 各自维护自己的条目循环
  - 公共的 `extendBuffer` 保留在 core 中，四个解码器共享

## 2026-06-30

### F2P4 重构

最大规模的一次重构。

**格式升级：F2P4（当前格式）**

- 32-bit BMP，BGRA 原生字节序，不需要通道映射
- 像素区取最大完全平方数 k²（k² × 4 ≤ payload），尾部数据以 BMP 额外数据存放，bfSize 停在像素区边界
- 文件名强制 AES-CTR 加密

**代码结构**

- 删除 TIFF 编解码器（初版尝试后弃用）
- 按格式版本拆分独立解码器：`f2p1-decode.js` / `f2p2-decode.js` / `f2p3-decode.js` / `f2p4-decode.js`
- 新增 `f2p4-encode.js`（预计算 BMP 尺寸 + 元数据写入）
- `f2p-encode.js` / `f2p-decode.js` 作为统一入口
- SW 编码逻辑使用 `precomputeBmp` + `buildBMPStream` 分块推送

**UI**

- 编码区文件列表：拖拽排序、删除、滚动位置保持
- 解码区文件列表：全选、批量下载
- chunk size 选择器 + 内存占用提示
- Toast 通知系统

### TIFF 尝试（已回退）

尝试加入 TIFF 格式支持，走过编码、解码、分组解码、IFD 重构后，最终认为维护成本过高，随 F2P4 重构一并删除。

### 微调

- 文件选择/检测交互打磨
- 按钮文案迭代
- iframe 拆除时机优化

## 2026-06-29

### Rspack 迁移 + 核心库分离

- 由 build.js 切换为 Rspack 构建，双入口（页面 + SW）
- 拆分 `f2p-core.js` 核心库供页面和 SW 共用
- SW 引入 job 管理（jobs Map），从 StreamSaver 中继演变为独立编解码执行器
- 新增 `style.css`，暗色主题

### SW 流式下载

- SW 全面接管编解码执行，页面仅做 UI
- 弃用 StreamSaver + mitm.html，改用 SW fetch 拦截 POST `/dl` + ReadableStream 直出 Response
- 引入 `postViaIframe` 解决浏览器下载触发
- 新增批量下载、全选

### F2P3 格式

- 32-bit BMP（通道映射 `[2,1,0,3]`），24-bit BMP 继续兼容
- `quickDetect` 自动识别版本
- 统一解码入口 `decodeContainer`

### F2P2 — 加密引入

- PBKDF2 + AES-256-CTR 文件内容加密
- 密码输入 + encMagic 密码校验
- 文件名可选加密

### F2P1 — 魔数 + 流式

- 引入 `0x46325031`（"F2P1"）魔数标识
- 文件大小从 4B 升到 8B（64-bit）
- 引入 StreamSaver + mitm.html 实现流式下载
- SW 首次引入（作为 StreamSaver 中继）

## 2026-06-28

### 初版 — 无魔数无加密

最早版本，不写 F2P 魔数，像素数据直接从 BMP 像素区开头写。

- 24-bit BMP，BGR 通道映射 `[2,1,0]`
- 无加密，无密码，文件名明文
- 格式：像素区开头写 `ps`（4B 总 payload 大小），`fileCount`（2B），然后文件条目 `nameLen`（2B）+ `name` + `size`（4B）
- 无 Service Worker，纯页面内编解码
- 文件读取用 `FileReader.readAsArrayBuffer`，读取失败时降级到 chunk 分半重试
- 输出用 `new Blob` + `URL.createObjectURL` 触发下载
- 单文件 `main.js`，`build.js` 构建
