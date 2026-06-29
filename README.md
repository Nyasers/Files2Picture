# F2P · Files to Picture

把文件打包隐写到 BMP 像素里，一张图带走。加密、流式、纯前端。

## 特性

- **加密打包** AES-256-CTR 加密内容，PBKDF2 密钥派生，密码验证有 magic check
- **超大文件支持** 单文件上限 2^53 - 1，文件数上限 2^32，总 payload 不限
- **流式处理** FileReader 分块 + Promise 链背压 + StreamSaver 直写磁盘，不 OOM
- **按需解码** 解析 BMP 时只读元信息，点哪个文件再按需提取
- **可调分块** 1 KB ~ 64 MB，大块利用磁盘 IO，小块兼容低端设备
- **编解码分离** 顶部标签切换，编码/解码互不干扰
- **纯前端** 所有操作在浏览器完成，不上传服务器

## 二进制格式

### F2P2（当前，加密格式）

```
[4B marker "F2P2"][4B fileCount][1B flags][16B salt][4B iter][4B magic][encrypted entries...][encrypted data...]
```

每个 entry：

```
flags=0x00（仅加密内容）：
[2B nameLen][UTF-8 name][8B dataLen][12B nonceData]

flags=0x01（加密内容+文件名）：
[2B nameLen][encrypted name][8B dataLen][12B nonceName][12B nonceData]
```

- marker = `0x46325032`（`F2P2`），识别格式版本
- flags 第 0 位：1 = 同时加密文件名
- salt（16B 随机）+ iter（4B，默认 10000）：PBKDF2 参数
- magic（4B）：加密后的 "F2P2"，用于密码验证
- 文件名加密用 `nonceName`，内容加密用 `nonceData`，独立的 12B 随机 nonce
- 文件大小 8B 大端（64 位），文件名长度 2B 大端（16 位）
- 全部为大端序

### F2P1（旧版加密支持）

```
[4B marker "F2P1"][4B fileCount][entries...][data...]
```

无加密，每文件 8B 大小。解码器自动兼容。

### 旧格式

```
[4B marker][2B fileCount][entries...][data...]
```

每文件 4B 大小。无 marker 校验。解码器自动兼容。

## 使用

```bash
npm run dev      # 开发 → http://localhost:3000（StreamSaver 需要 HTTP）
npm run build    # 生产构建 → dist/
```

1. 打开页面，顶部选编码/解码模式
2. 编码：拖放文件 → 可选密码 / 文件名加密 → 点「生成图片」→ StreamSaver 保存
3. 解码：拖放 BMP → 自动尝试空密码识别 → 输入密码后点「提取」→ 点文件下载

## 密码说明

- 留空 = 空字符串密钥（每份 BMP 有随机 salt，密文每次都不同）
- 设密码 = 自定义密钥
- 解码时密码错误会被 magic check 捕获，显示"密码错误"
- 文件名加密为独立选项（勾选后 entry 的文件名也被 AES-CTR 加密）

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
