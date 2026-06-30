# Files2Picture · F2P4

把任意文件打包隐写到 **32-bit BMP** 像素里，一张图带走。加密、流式、纯前端。

## 特性

- **加密打包** AES-256-CTR 加密内容，PBKDF2 密钥派生，密码校验加密 magic
- **超大文件支持** 单文件上限 2^53 - 1，文件数上限 2^32，总 payload 不限
- **BGRA 原生编码** 数据字节按像素的 BGRA 通道顺序直接写入，通道映射零开销
- **32-bit BMP 直写** 每像素 4 字节（BGRA），Alpha 通道承载数据，密度比 24-bit 高 33%
- **无行填充浪费** 32-bit BMP 天然 4 字节对齐，零 padding
- **流式处理** ReadableStream 分块 + StreamSaver 直写磁盘，不 OOM
- **按需解码** 解析时只读元信息，点哪个文件再按需提取解密
- **编解码分离** 顶部标签切换，互不干扰
- **纯前端** 所有操作在浏览器完成，不上传服务器

## 二进制格式

### F2P4（当前格式）

BMP 规格：**32-bit BGRA**，`BIT_COUNT = 32`，每像素 4 字节，行步长 = 宽度 × 4。

数据直接按 **BGRA 原生顺序**写入像素，字节 N → 像素偏移 N（B=0, G=1, R=2, A=3），无需通道映射。4 字节对齐的块可直接 `Uint8Array.set()` 拷贝。

元数据流（位于像素数据头部，全部大端序）：

```
偏移  0: [4B magic  = 0x46325034 "F2P4"]
偏移  4: [4B fileCount]
偏移  8: [16B salt]
偏移 24: [4B iter (PBKDF2 迭代次数)]
偏移 28: [4B encMagic (AES 加密的 "F2P4"，用于密码校验)]
偏移 32: [文件条目...]
```

每个文件条目（**文件名强制加密**）：

```
[2B nameLen][encrypted name][8B dataLen][12B nameNonce][12B dataNonce]
```

- magic = `0x46325034`（`F2P4`），按 BGRA 原生读取可直验
- salt（16B 随机）+ iter（4B，默认 10000）：PBKDF2 参数
- encMagic（4B）：用 AES-CTR 加密的 "F2P4"，解码时解密对比以验证密码
- 文件名用 AES-CTR + nameNonce 加密，文件内容用 dataNonce 加密，nonce 独立随机
- 文件大小 8B 大端（64-bit），文件名长度 2B 大端（16-bit）
- F2P4 **无 flags 字节**，文件名强制加密

### 向下兼容

解码器自动识别 F2P4 / F2P3 / F2P2 / F2P1：

| 版本     | 魔数         | BMP 位深 | 通道映射         |
| -------- | ------------ | -------- | ---------------- |
| **F2P4** | `0x46325034` | 32-bit   | BGRA 原生        |
| F2P3     | `0x46325033` | 32-bit   | `[2,1,0,3]` 映射 |
| F2P2     | `0x46325032` | 24-bit   | `[2,1,0]` 映射   |
| F2P1     | `0x46325031` | 24-bit   | `[2,1,0]` 映射   |

各版本解码器独立文件，按 magic 分发：

```
f2p-decode.js  → 识别 magic，派发到对应版本
  ├─ f2p1-decode.js  F2P1（无加密）
  ├─ f2p2-decode.js  F2P2（24-bit，加密，映射编码）
  ├─ f2p3-decode.js  F2P3（32-bit，加密，映射编码）
  └─ f2p4-decode.js  F2P4（32-bit，加密，BGRA 原生）
```

F2P4 编码器在 `f2p4-encode.js`，通过 `f2p-encode.js` 统一入口导出。

## 使用

```bash
npm run dev      # 开发 → http://localhost:3000（StreamSaver 需要 HTTP）
npm run build    # 生产构建 → dist/
```

1. 打开页面，顶部选编码/解码模式
2. 编码：拖放文件 → 可选密码 → 点「生成图片」→ StreamSaver 保存
3. 解码：拖放 BMP → 输入密码 → 点「提取」→ 点文件下载

## 密码说明

- 留空 = 空字符串密钥（每份 BMP 有随机 salt，密文每次都不同）
- 设密码 = 自定义密钥
- 解码时密码错误会被 encMagic 校验捕获，显示"密码错误"
- **F2P4 强制加密文件名**，无此开关（F2P3 及更早版本保留文件名加密选项）

## 分块大小

读取分块在顶部栏设置，编解码共用：

- 大文件、大分块（4 MB+）：磁盘 IO 吞吐高，适合高性能设备
- 小文件、小分块（64 KB 以下）：兼容旧设备，内存占用低
- 默认 64 KB

## 构建

```bash
npm install
npm run build    # Rspack + html-minifier-terser 后处理
```

产物在 `dist/`，通过任意静态托管部署。
