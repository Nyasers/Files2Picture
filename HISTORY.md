# 更新日志

## 2026-07-03

### F2P6 分卷编码

**F2P6 格式设计**

- 数据级分卷：索引分卷 (segID=0) 含文件条目 + 部分数据，数据分卷 (segID>0) 只有数据
- 索引分卷用 segSalt 加密全部内容，数据分卷各有独立 segSalt 通过 indexSalt 加密保护
- `precomputeSegments` 根据目标 BMP 文件大小自动计算分卷数量和每卷数据量
- 分卷间通过 `encMagic` 校验密码和同批归属
- 文件条目与数据共享同一 AES-CTR 流（不独立加密文件名）

**顺序编码协调器**

- 所有分卷下载请求同时触发，SW 内逐个编码，降低内存峰值
- `encodeSegmentsSequentially` 按 segID 顺序循环，每分卷完成后再 resolve 该分卷的 deferred stream
- 无每分卷子任务，编码在任务管理器中显示为单个合并任务

**流式解码 (F2P6)**

- `serveF2P6DecodeStream` 通过 `/file/<hash>/<filename>` 拦截流式响应
- `extractFileDataRange` 按 64KB 块提取指定文件的指定字节范围
- 全局坐标映射：索引分卷数据部分 as segID=0 + 数据分卷按 segID 排序后赋予连续 globalStart/globalEnd
- 支持分卷跨区读取（单个文件可跨越索引分卷和数据分卷）

**块加密 (chunked AES-CTR)**

- 数据分卷每 64KB chunk 独立加密，`blockOff = 1 + offset/16` 保持计数器连续
- 支持进度上报和取消回调（`onProgress` / `isCancelled`）

**魔数集中管理**

- 所有版本魔数 `F2P1`–`F2P6` 移至 `f2p-core.js` 统一导出
- 各编码器/解码器改为 import 常量，消除硬编码

**解码状态重构**

- 7 个全局变量 (`decFile`, `decEntries`, `decKey`, `decBmpMeta`, `decDataStart`, `decSel`, `dd`) → 单一 `decResult` 对象 + `decSel` 列表
- `decResult = { type: "f2p6"|"legacy", entries, indexInfo, dataSegments }`
- 文件选择支持多选，F2P6 自动在所有选中的 BMP 中找索引分卷和数据分卷

**分卷大小选择器**

- 编码区新增分卷大小下拉菜单（10MB–4GB）
- 实时校验文件列表是否能在索引分卷中装下
- 不设分卷时 (0) 全部数据装进索引分卷，保持向后兼容

**修复：`extractFileDataRange` 偏移量错误**

- `readStart` / `fileEnd` 未加 `entry.globalOffset`，流式解码所有文件从全局偏移 0 读
- 导致所有提取文件都包含文件 0 开头的数据（按各自大小截断）
- 非流式 `extractFileData` 不受影响（已正确使用 globalOffset）

**其他改动**

- 术语统一：分片/分包 → 分卷
- `encode-tab.js` 新增 `rmF` 删除按钮
- `localStorage` → `sessionStorage` 用于 tab 状态持久化
- `main.js` 清理 SW 初始化流程
- 移除 `/seg-dl` 路由，全部走统一 `/files?id=X&idx=Y`
- F2P1-F2P5 编码器保留但不再从 `f2p-encode.js` 导出
- F2P5 及更早版本解码路径未受影响

## 2026-07-02

### 密码输入框回归普通文本框

- 密码 input 从 `type="password"` 改回 `type="text"`，浏览器不尊重 `autocomplete="off"`，且密码管理器会干扰密码框
- 移除密码可见性切换按钮（🙈/👁️）及 `setupPwdToggle` 逻辑，`type="text"` 天然可见无需切换
- 移除 `.pwd-toggle` 相关 CSS 样式
- README 同步更新：移除特性列表和密码说明中的窥视切换相关文案

## 2026-07-02

### F2P5 格式升级 + 任务历史 + 质量加固

**F2P5 格式升级**

- 魔数 `0x46325034` → `0x46325035`（F2P5）
- AES-CTR 从 short counter（96-bit?）升级为 **128-bit 完整 counter**，name/data nonce（12B）→ name/data counter（16B），counter 宽度与密钥块一致，无截断无溢出
- `buildCtr` 重构：接受 `bits` 参数，`normalizeBits` 统一边界（1-128），partial byte 掩码保留 nonce 高位，与 WebCrypto `length` 语义对齐
- 统一编码入口：`f2p5-encode.js` 提供 `precomputeBmp` + `writeF2P5Header`，SW 编码路径改用此模块，消除内联布局计算与编码器之间的差异
- 新增 `f2p5-decode.js`，解码入口 `decodeContainer` 优先检测 F2P5
- `f2p-encode.js` 代理到 `coders/f2p5-encode.js`，`f2p4-encode.js` 不再存在

**密码 UI 增强**

- 密码 input 从 `type="text"` 改为 `type="password"`，加 `autocomplete="off"`
- 新增密码可见性切换按钮（🙈 / 👁️），`ui-shell.js` 中 `setupPwdToggle` 统一处理编码/解码两个输入框
- CSS 新增 `.pwd-toggle` 按钮样式

**Tab 状态持久化**

- 当前标签页信息写入 `sessionStorage`（`f2p.tab`），页面刷新后自动恢复
- 多标签页互不干扰，`switchTab` 统一管理持久化

**任务历史系统**

- `task-manager.js` 全面重构：完成/错误/取消的任务不再被移除，而是移入 `taskHistory[]`
- 保留最近 50 条记录，active jobs 在上方、history 在下方以 `opacity: 0.7` 区分
- `renderTasks()` 全量渲染取代 `removeTaskItem()` 增量删除
- 已取消任务 (`job-update status=cancelled`) 正确进入历史，不再静默消失
- `.task-item.history` CSS 给历史任务视觉区分

**健壮性加固**

- 全模块添加 `"use strict"`（15 个文件全部加严）
- `f2p2-decode.js` / `f2p3-decode.js` 修复 `const size` hoisting 问题（`size` 在 if/else 分支各用 `const` 声明，无法在分支外访问 → 改为外层 `let size`）
- `sw.js` 中 `pendingStreams.delete(jobId)` 加入异常/超时路径清理，防止内存泄漏
- `jobs.delete(jobId)` 加入 cancel/error 处理器，取消后正确移除 job
- `serveEncodeStream` 的 `cancel()` 回调异步设 status，与 `job-update` 消息路径一致

**编码 UI 重置**

- 编码提交后重置拖放区文字为「拖放文件，或点击选择」、按钮文字为「🎨 生成」

**进度显示优化**

- 多文件编码时 `currentFile` 改为 `[i/n] filename` 格式，清晰指示当前处理到第几个文件

### 修复：尾巴数据错序导致的 hash 不一致

**问题**：文件编码后编解码 hash 不一致，分块越大越明显。

**根因**：`sw.js` 中 `bmp.pad()` 重构（3ca5f79）将尾巴从 `wChunk` 内联写入改为返回独立 `tailBuf`，调用者在 `runEncode` 末尾同步 `push(tail)`。但像素行通过 `writeChain` Promise 链异步推送（`flushRow` 做 `writeChain.then(() => onRow(copy))`），同步 `push(tail)` 先于微任务中的行回调入队，导致 BMP 字节顺序错乱：尾巴数据出现在像素行之前。解码器从偏移 54 读到的是尾巴数据而非文件内容。

**修复**：将 `push(tail)` 移至 `await bmp.flushAll()` 之后，确保所有像素行入队完成后再推尾巴。

## 2026-07-01

### Service Worker 指示灯

- 页脚新增 SW 状态指示器，七色圆点 + 文字标签，标签跟随状态变色
- 状态：不支持/注册中/安装中/等待激活/新版本可用/更新中/已就绪/注册失败
- 首次激活与运行时更新区分，`classList` 维护状态类，`<div>` 改为 `<span>`
- 无障碍 `role="status"`，`prefers-reduced-motion` 支持

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
