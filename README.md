# Files2Picture · F2P5

把任意文件打包隐写到 32-bit BMP 像素里，一张图带走。加密、流式、纯前端。

## 特性

- **加密打包** AES-256-CTR 加密内容，PBKDF2 密钥派生，密码校验加密 magic
- **超大文件支持** 单文件上限 2⁵³ − 1，文件数上限 2³²，总 payload 不限
- **128-bit 完整 counter** AES-CTR 使用 128-bit counter，非 short counter，nonce 永不碰撞，大文件无溢出风险
- **BGRA 原生编码** 数据字节按像素的 BGRA 顺序直接写入，零通道映射开销
- **32-bit BMP 直写** 每像素 4 字节，Alpha 通道承载数据，密度比 24-bit 高 33%
- **零填充浪费** 像素区取最大完全平方数 k²（k²×4 ≤ payload），尾部数据以 BMP 额外数据存放，bfSize 停在像素区边界，F2P 自读尾巴
- **流式处理** Service Worker 拦截 GET /file/，ReadableStream 分块推送，浏览器直写磁盘
- **任务历史** 编码/解码完成后保留记录，进度条定格 100%，可追溯近期任务
- **拖拽排序** 编码区文件列表支持拖拽调整顺序，解码顺序与编码一致
- **Tab 状态保持** 当前选中的编解码/任务标签页在 session 内持久化，刷新页面后自动恢复
- **编解码分离** 顶部标签切换，互不干扰
- **纯前端** 所有操作在浏览器完成，不上传服务器
- **Service Worker 指示灯** 页脚实时显示 SW 生命周期状态，七色联动文字变色

## 二进制格式

### F2P5（当前格式）

BMP 规格：**32-bit BGRA**，每像素 4 字节，行步长 = 宽度 × 4。数据直接按 BGRA 原生顺序写入，字节 N → 像素偏移 N（B=0, G=1, R=2, A=3），4 字节对齐的块可直接 `Uint8Array.set()` 拷贝。

### BMP 文件布局

BMP header（54 字节）中的三个关键字段：

- `bfSize`（offset 2）= `54 + k²×4`，BMP 规范值，只算 header + 像素区
- `biSizeImage`（offset 34）= `k²×4`，像素区大小
- 实际文件/流的大小 = `54 + ps`（含尾巴），靠 Content-Length 透传

像素边长 `k = floor(sqrt(floor(ps/4)))`，即满足 `k²×4 ≤ ps` 的最大完全平方数的平方根。像素区被数据完全填满，没有零填充。剩下的 `ps − k²×4` 字节紧跟在像素区后面，解码器越过 bfSize 直接读。

元数据流（位于像素数据头部，全部大端序）：

```
偏移  0: [4B magic  = 0x46325035 "F2P5"]
偏移  4: [4B fileCount]
偏移  8: [16B salt]
偏移 24: [4B iter（PBKDF2 迭代次数）]
偏移 28: [4B encMagic（AES 加密的 "F2P5"，用于密码校验）]
偏移 32: [文件条目...]
```

每个文件条目（**文件名强制加密**，独立 AES-CTR counter）：

```
[2B nameLen][encrypted name][8B dataLen][16B nameCounter][16B dataCounter]
```

- magic = `0x46325035`，按 BGRA 原生读取可直验
- salt（16B 随机）+ iter（4B，默认 10000）：PBKDF2 参数
- encMagic 用 AES-CTR（length=128）加密 "F2P5"，解码时解密对比以验证密码
- 文件名用 AES-CTR + nameCounter（16B 独立随机）加密，文件内容用 dataCounter（16B 独立随机）加密，AES-CTR length = 128（全 counter，永不溢出）
- 文件大小 8B 大端（64-bit），文件名长度 2B 大端（16-bit）
- 所有 counter 均为 16B 完全独立，nonce + counter 总宽度 = 128-bit，无需 truncate
- F2P5 **无 flags 字节**，文件名强制加密

### 向下兼容

解码器自动识别 F2P5 / F2P4 / F2P3 / F2P2 / F2P1：

| 版本     | 魔数         | BMP 位深 | 通道映射         | Counter 宽度 |
| -------- | ------------ | -------- | ---------------- | ------------ |
| **F2P5** | `0x46325035` | 32-bit   | BGRA 原生        | 128-bit      |
| F2P4     | `0x46325034` | 32-bit   | BGRA 原生        | short        |
| F2P3     | `0x46325033` | 32-bit   | `[2,1,0,3]` 映射 | short        |
| F2P2     | `0x46325032` | 24-bit   | `[2,1,0]` 映射   | short        |
| F2P1     | `0x46325031` | 24-bit   | `[2,1,0]` 映射   | 无加密       |

## 架构

编解码在 Service Worker 中执行，页面仅负责 UI 交互。下载通过 SW fetch 拦截 + 302 重定向 + ReadableStream 直出。

```
编码区点击生成 → postMessage encode → SW 同步设 pendingStreams
              → 回复 encode-stream-ready
              → triggerDownload("/files?id=<jobId>")

解码区点击下载 → postMessage decode-stream-prepare / decode-group
              → SW 同步设 pendingDecodeStreams / pendingDecodeGroups
              → 回复 decode-stream-ready / decode-group-ready
              → triggerDownload("/files?id=<jobId>[&idx=<n>]")
```

下载触发链路：

```
页面: 创建隐藏 iframe，src = /files?id=<xxx>[&idx=<n>]
 SW:  拦截 GET /files
      → 查 pendingStreams / pendingDecodeGroups
      → 派生 hash = SHA1(id[+idx])
      → 注册 fileRoutes[hash] = { id, idx? }
      → 302 → /file/<hash>/<filename>

页面: iframe 跟随 302
 SW:  拦截 GET /file/<hash>/<filename>
      → 查 fileRoutes，清除条目
      → 创建 ReadableStream 分块推送
      → 设置 Content-Disposition: attachment
      → 浏览器接收流式写入磁盘

 SW:  推送第一块之前 postMessage job-start
      页面收到 job-start 后移除 iframe
```

批量下载逐个触发 `triggerDownload`，各 iframe 独立导航互不抢占。

SW 不缓存完整文件，逐 chunk 读写，内存占用稳定在 `chunkSize × 8` 左右。

### 编码流

编码使用 `precomputeBmp` 预计算 BMP 布局（元数据大小 + 数据大小），然后通过 `buildBMPStream` 驱动 `ReadableStream` 分块推送。元数据头统一通过 `writeF2P5Header` 写入，与解码端布局计算路径一致，消除格式差异。

## 源文件结构

```
src/
├── index.html         ← 页面骨架
├── main.js            ← 入口，import 各模块并注册 SW
├── style.css          ← 暗色主题样式
├── sw.js              ← Service Worker：编解码执行 + 流式下载拦截 + PWA 缓存
└── lib/
    ├── sw-client.js       ← SW 通信层（消息投递、Toast、triggerDownload、状态指示灯）
    ├── ui-shell.js        ← Tab 切换 + sessionStorage 状态保持 + 密码可见性切换
    ├── task-manager.js    ← 任务列表渲染 + Job 生命周期管理 + 任务历史
    ├── encode-tab.js      ← 编码 Tab：文件选择、拖放、拖拽排序、提交任务
    ├── decode-tab.js      ← 解码 Tab：图片选择、元信息解析、单文件/批量下载
    ├── f2p-core.js        ← 核心库（加密工具、BMP 构建/读取、容器检测）
    ├── f2p-encode.js      ← 编码入口，代理到 F2P5 编码器
    ├── f2p-decode.js      ← 解码入口，自动识别版本派发
    └── coders/
        ├── f2p5-encode.js ← F2P5 编码器（预计算尺寸 + 写入头 + 文件条目）
        ├── f2p5-decode.js ← F2P5 解码器（128-bit counter + 32-bit BGRA 原生）
        ├── f2p4-decode.js ← F2P4 解码器（short counter + 32-bit BGRA 原生）
        ├── f2p3-decode.js ← F2P3 解码器（加密 + 32-bit 通道映射）
        ├── f2p2-decode.js ← F2P2 解码器（加密 + 24-bit）
        └── f2p1-decode.js ← F2P1 解码器（无加密 + 24-bit）
```

## 使用

```bash
npm install
npm run build    # 生产构建 → dist/
npm run dev      # 开发 → http://localhost:3000
```

1. 编码：拖放文件 → 可选密码 → 拖拽排序 → 生成图片
2. 解码：拖放 BMP → 输入密码 → 提取 → 点选或批量下载
3. 任务：实时进度条，完成后保留记录供查阅

## 密码说明

- 留空 = 空字符串密钥（每份 BMP 有随机 salt，密文每次都不同）
- 设密码 = 自定义密钥
- 解码时密码错误会被 encMagic 校验捕获
- F2P5 强制加密文件名

## 分块大小

顶部栏可调，编解码共用。大块（4 MB+）适合高性能设备，小块（64 KB 以下）兼容低端设备。默认 64 KB。选择值自动持久化到 localStorage。

## 构建

```bash
npm install
npm run build    # Rspack + html-minifier-terser
```

产物在 `dist/`，通过任意静态托管部署。
