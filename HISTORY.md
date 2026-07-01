# 更新日志

## 2026-07-01

### 握手简化 + 增量渲染

**握手优化**

- 编码：`encode-stream-prepare` / `encode-stream-ready` 独立握手合并入 `encode` 消息，SW 同步设 pendingStreams 后直接回复 ready，再异步跑 runEncode
- 解码单文件：`handleDecodeStreamPrepare` 改为同步设 pending 条目，`crypto.subtle.importKey` 的 Promise 存入 `keyPromise`，fetch handler 延迟 await
- 解码批量：同上，`keyPromise` 延迟到 fetch handler

**性能**

- 解码流式读取中 `readBmpHeader` 移出循环体，每 chunk 不再重复解析 BMP 头

**UI 渲染**

- 任务列表改为增量更新：progress 只改对应 DOM 节点的进度条宽度和百分比文本，不再全量 `innerHTML` 重绘
- 完成/错误/取消只移除对应 DOM 节点

## 2026-06-30

### F2P4 重构

本次变更是最大规模的一次重构，涉及以下方面：

**格式升级：F2P4（当前格式）**

- 32-bit BMP，BGRA 原生字节序，不再需要通道映射
- 像素区取最大完全平方数 k²（k² × 4 ≤ payload），零填充浪费
- 尾部数据以 BMP 额外数据存放，bfSize 停在像素区边界
- 文件名强制 AES-CTR 加密，nonce 每文件独立随机

**代码结构**

- 删除 TIFF 编解码器（初版尝试后弃用）
- 拆分独立解码器：`f2p1-decode.js` / `f2p2-decode.js` / `f2p3-decode.js` / `f2p4-decode.js`
- 新增 `f2p4-encode.js` 编码器（预计算 BMP 尺寸 + 元数据写入）
- `f2p-encode.js` / `f2p-decode.js` 作为统一入口
- SW 编码逻辑重构，使用 `precomputeBmp` + `buildBMPStream` 分块推送

**UI 完善**

- 编码区文件列表：拖拽排序、删除、滚动位置保持
- 解码区文件列表：全选、批量下载
- chunk size 选择器 + 内存占用提示
- Toast 通知系统

### 微调优化

- 文件选择/检测的交互细节打磨
- 按钮文案迭代
- iframe 拆除时机优化

## 2026-06-29

### Rspack 迁移 + 核心库分离

- 由 build.js 切换为 Rspack 构建，多 compiler 双入口（页面 + SW）
- 拆分 `f2p-core.js` 核心库（加密、BMP 读写、格式检测），页面和 SW 共用
- SW 引入 job 管理（jobs Map），支持进度上报和取消任务
- 新增 `style.css`，暗色主题 UI

### SW 流式下载 + 表单 iframe

- SW 全面接管编解码执行，页面仅做 UI
- 使用 SW fetch 拦截 `POST /dl` + ReadableStream 实现流式下载
- 引入 `postViaIframe` 解决浏览器下载触发问题
- 新增批量下载、全选功能
- 解码元信息解析与文件提取分离（按需解码）

### F2P3 格式

- 新增 F2P3 格式：32-bit BMP + 通道映射 `[2,1,0,3]`
- `quickDetect` 自动识别格式版本
- 统一解码入口 `decodeContainer`，自动路由到对应版本的解码器

## 2026-06-28 初始版本

- 第一个可运行的 F2P 版本（F2P1 / F2P2），build.js 构建，单文件 main.js
