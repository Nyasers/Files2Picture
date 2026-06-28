# Files2Picture · Files to Picture

纯前端 BMP 隐写工具，把任意文件直接写进像素字节。

## 特性

- **零依赖** 单页面应用，无 WASM、无 Worker、无外部库
- **流式编码** 文件逐个读入逐块写入，内存开销 O(1)，测过 2GB 不 OOM
- **按需解码** 解析 BMP 时只读元信息（文件名、大小），用户点哪个文件再提取哪个
- **无服务器** 所有编解码都在本地浏览器完成

## 二进制格式

BMP 像素区从字节 0 开始：

```
[4B payloadLen] [2B fileCount] [元信息区] [数据区]
```

payloadLen 不含自身 4 字节，所以 `payloadLen = 2 + metaSize + dataSize`。

元信息区按文件数重复：

```
[2B nameLen (大端)] [UTF-8 name] [4B dataLen (大端)]
```

解码时从像素字节 6 起一口气把 `min(payloadLen - 2, 64KB)` 全读进来，元信息在里头，然后顺序解析。提取具体文件时再按 dataOffset 跳到数据区。

## 使用

1. 打开页面（本地或已部署）
2. 编码侧选文件（拖放或点击），点生成图片，下载 BMP
3. 解码侧上传 BMP，点提取，看到文件列表后点击文件名下载

## 本地开发

```bash
npm install
npm run build
```

产物在 `out/index.html`，单文件零外部引用。直接用浏览器打开即可。

## 部署

推送到 GitHub，通过 Cloudflare Pages 自动部署：

| 配置 | 值 |
|---|---|
| 框架 | 无（纯静态） |
| 构建命令 | `npm install && npm run build` |
| 构建输出目录 | `out` |
| 生产分支 | `main` |
| 部署命令 | 留空（Pages 自动部署） |

**注意**：CF Pages 的部署命令不要填 `npx wrangler deploy`，那是 Worker 的写法。Pages 项目只需要构建输出目录，部署是自动的。

也支持手动部署：

```bash
npm install && npm run build
npx wrangler pages deploy out --project-name=files2picture
```
