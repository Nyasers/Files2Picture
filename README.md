# Files2Picture · F2P6

把任意文件打包隐写到 32-bit BMP 像素里，一张图带走。加密、流式、纯前端。支持**分卷编码**突破单 BMP 文件大小限制。

## 特性

- **分卷编码** 索引分卷包含文件条目 + 部分数据，数据分卷只有数据，多 BMP 无缝拼接
- **加密打包** AES-256-CTR 加密内容，PBKDF2 密钥派生，密码校验加密 magic
- **超大文件支持** 单文件上限 2⁵³ − 1，文件数上限 2³²，总 payload 不限
- **128-bit 完整 counter** AES-CTR 使用 128-bit counter，非 short counter，nonce 永不碰撞，大文件无溢出风险
- **BGRA 原生编码** 数据字节按像素的 BGRA 顺序直接写入，零通道映射开销
- **32-bit BMP 直写** 每像素 4 字节，Alpha 通道承载数据，密度比 24-bit 高 33%
- **零填充浪费** 像素区取最大完全平方数 k²（k²×4 ≤ payload），尾部数据以 BMP 额外数据存放，bfSize 停在像素区边界，F2P 自读尾巴
- **流式处理** Service Worker 拦截 GET /file/，ReadableStream 分块推送，浏览器直写磁盘
- **顺序编码协调器** 分卷逐个编码，内存峰值可控，无每分卷子任务
- **任务历史** 编码/解码完成后保留记录，进度条定格 100%，可追溯近期任务
- **拖拽排序** 编码区文件列表支持拖拽调整顺序，解码顺序与编码一致
- **Tab 状态保持** 当前选中的编解码/任务标签页在 session 内持久化，刷新页面后自动恢复
- **编解码分离** 顶部标签切换，互不干扰
- **纯前端** 所有操作在浏览器完成，不上传服务器
- **Service Worker 指示灯** 页脚实时显示 SW 生命周期状态，七色联动文字变色

## 二进制格式

### F2P6（当前格式）

BMP 规格：**32-bit BGRA**，每像素 4 字节，行步长 = 宽度 × 4。数据直接按 BGRA 原生顺序写入，字节 N → 像素偏移 N（B=0, G=1, R=2, A=3），4 字节对齐的块可直接 `Uint8Array.set()` 拷贝。

### BMP 文件布局（分卷）

BMP header（54 字节）中的三个关键字段：

- `bfSize`（offset 2）= `54 + k²×4`，BMP 规范值，只算 header + 像素区
- `biSizeImage`（offset 34）= `k²×4`，像素区大小
- 实际文件/流的大小 = `54 + 8 + payloadSize`（含尾巴），靠 Content-Length 透传

像素边长 `k = floor(sqrt(floor((8 + payloadSize) / 4)))`，即满足 `k²×4 ≤ 8 + payloadSize` 的最大完全平方数的平方根。像素区被数据完全填满，没有零填充。剩下的 `(8 + payloadSize) − k²×4` 字节紧跟在像素区后面，解码器越过 bfSize 直接读。

#### 索引分卷（segID=0）

```
明文头（36 字节）:
  [4B magic    = 0x46325036 "F2P6"]
  [4B encMagic]                ← AES-CTR("F2P6", key, segSalt, 0, 128) 前 4B
  [8B segID=0]
  [16B segSalt]                ← PBKDF2 salt + AES-CTR counter base
  [4B iter]                    ← PBKDF2 迭代次数（默认 10000）

加密区（AES-CTR blockOff=1）:
  [16B indexSalt]              ← 用于加密数据分卷 segSalt
  [8B segCount]                ← 总分卷数
  [8B fileCount]               ← 文件总数
  [fileEntries...]             ← 文件条目
  [data...]                    ← 该分卷承载的文件数据
```

文件条目（与 data 共享同一 AES-CTR 流）：

```
[2B nameLen][8B dataLen][nB name(UTF-8)]  重复 fileCount 次
```

#### 数据分卷（segID>0）

```
明文头（32 字节）:
  [4B magic    = 0x46325036 "F2P6"]
  [4B encMagic]                ← AES-CTR("F2P6", key, segSalt, 0, 128) 前 4B
  [8B segID=N]
  [16B encryptedSegSalt]       ← AES-CTR(segSalt, key, indexSalt, 0, 128)

加密区（AES-CTR blockOff=1）:
  [data...]                    ← chunked 加密写入，64KB 块
```

### 加密模型

```
索引分卷:
  encMagic: AES-CTR("F2P6", key, segSalt,      0, 128)  → 取前 4B
  加密区:   AES-CTR(明文,   key, segSalt,      1, 128)  → 全部加密

数据分卷:
  encryptedSegSalt: AES-CTR(segSalt, key, indexSalt, 0, 128)
  encMagic:         AES-CTR("F2P6",  key, segSalt,  0, 128)  → 取前 4B
  数据区:           AES-CTR(原文,    key, segSalt,  1, 128)  → chunked
```

### 向下兼容

解码器自动识别 F2P6 / F2P5 / F2P4 / F2P3 / F2P2 / F2P1：

| 版本     | 魔数         | BMP 位深 | 通道映射         | Counter 宽度 | 备注       |
| -------- | ------------ | -------- | ---------------- | ------------ | ---------- |
| **F2P6** | `0x46325036` | 32-bit   | BGRA 原生        | 128-bit      | 分卷编码   |
| F2P5     | `0x46325035` | 32-bit   | BGRA 原生        | 128-bit      | 单 BMP     |
| F2P4     | `0x46325034` | 32-bit   | BGRA 原生        | short        |            |
| F2P3     | `0x46325033` | 32-bit   | `[2,1,0,3]` 映射 | short        |            |
| F2P2     | `0x46325032` | 24-bit   | `[2,1,0]` 映射   | short        |            |
| F2P1     | `0x46325031` | 24-bit   | `[2,1,0]` 映射   | 无加密       |            |

## 架构

编解码在 Service Worker 中执行，页面仅负责 UI 交互。下载通过 SW fetch 拦截 + 302 重定向 + ReadableStream 直出。

```
编码区点击生成 → postMessage encode → SW 预计算分卷布局
              → 回复 encode-ready（含分卷数）
              → triggerDownload("/files?id=<jobId>&idx=0") (× segCount)

解码区点击下载 → postMessage f2p6-decode-group
              → SW 存储分组信息
              → triggerDownload("/files?id=<gid>&idx=<n>")
```

下载触发链路：

```
页面: 创建隐藏 iframe，src = /files?id=<xxx>[&idx=<n>]
 SW:  拦截 GET /files
      → 查 pendingEncodeGroups / pendingDecodeGroups / pendingF2P6DecodeGroups
      → 派生 hash = SHA1(id[+idx])
      → 注册 fileRoutes[hash] = { id, idx, kind }
      → 302 → /file/<hash>/<filename>

页面: iframe 跟随 302
 SW:  拦截 GET /file/<hash>/<filename>
      → 查 fileRoutes，清除条目
      → 创建 ReadableStream 分块推送
      → 设置 Content-Disposition: attachment + Content-Length
      → 浏览器接收流式写入磁盘
```

批量下载逐个触发 `triggerDownload`，各 iframe 独立导航互不抢占。

SW 不缓存完整文件，逐 chunk 读写，内存占用稳定在 `chunkSize × 8` 左右。

### 编码流

编码使用 `precomputeSegments` 预计算分卷布局，然后通过 `encodeSegmentsSequentially` 顺序协调器逐个编码。每个分卷通过 `ReadableStream` 推送 BMP 头部 + 像素行 + 尾巴，Chunked AES-CTR 保持计数器连续。

## 源文件结构

```
src/
├── index.html         ← 页面骨架
├── main.js            ← 入口，挂载 Vue 应用并注册 SW
├── style.css          ← 暗色主题样式
├── App.vue            ← 根组件：布局 + 标签切换
├── assets/
│   ├── favicon.svg    ← 站点图标
│   └── manifest.json  ← PWA manifest
├── components/
│   ├── TopBar.vue     ← 顶部标签栏 + ChunkSize 选择器
│   ├── EncodePanel.vue← 编码面板：文件拖放、密码、分卷大小、提交
│   ├── DecodePanel.vue← 解码面板：BMP 选择、密码、解码触发
│   ├── TasksPanel.vue ← 任务列表：实时进度 + 历史记录
│   ├── ToastHost.vue  ← Toast 通知容器
│   └── SWStatus.vue   ← Service Worker 状态指示灯
├── composables/
│   └── useSettings.js ← localStorage 设置持久化
├── sw.js              ← Service Worker：编解码执行 + 流式下载拦截 + PWA 缓存 + 顺序协调器
└── lib/
    ├── sw-client.js       ← SW 通信层（消息投递、Toast、triggerDownload）
    ├── f2p-core.js        ← 核心库（加密工具、BMP 构建/读取、魔数常量）
    ├── f2p-encode.js      ← 编码入口，代理到 F2P6 编码器
    ├── f2p-decode.js      ← 解码入口，自动识别版本派发
    └── coders/
        ├── f2p6-encode.js ← F2P6 编码器（precomputeSegments、chunked 加密、进度/取消）
        ├── f2p6-decode.js ← F2P6 解码器（extractFileData/DataRange、流式提取）
        ├── f2p5-encode.js ← F2P5 编码器（保留，未使用）
        ├── f2p5-decode.js ← F2P5 解码器
        ├── f2p4-decode.js ← F2P4 解码器
        ├── f2p3-decode.js ← F2P3 解码器
        ├── f2p2-decode.js ← F2P2 解码器
        └── f2p1-decode.js ← F2P1 解码器
```

## 使用

```bash
npm install
npm run build    # 生产构建 → dist/
npm run dev      # 开发 → http://localhost:3000
```

1. 编码：拖放文件 → 可选密码 → 可选分卷大小 → 拖拽排序 → 生成图片
2. 解码：拖放 BMP（支持多选）→ 输入密码 → 解码分卷 → 点选或批量下载
3. 任务：实时进度条，完成后保留记录供查阅

## 密码说明

- 留空 = 空字符串密钥（每份 BMP 有随机 salt，密文每次都不同）
- 设密码 = 自定义密钥
- 解码时密码错误会被 encMagic 校验捕获
- F2P6 强制加密所有内容（文件条目 + 数据）

## 分卷大小

编码区新增分卷下拉菜单。选 0（默认）不分卷，全部数据装入单个 BMP。选 10MB+ 时自动切分，每张 BMP 不超过目标大小。解码时只需将所有 BMP 一起拖入解码区，解码器自动识别索引分卷和数据分卷。

## 分块大小

顶部栏可调，编解码共用。大块（4 MB+）适合高性能设备，小块（64 KB 以下）兼容低端设备。默认 64 KB。选择值自动持久化到 localStorage。

## 构建

```bash
npm install
npm run build    # Rspack + html-minifier-terser
```

产物在 `dist/`，通过任意静态托管部署。