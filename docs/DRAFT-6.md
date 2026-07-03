# F2P6 · 分卷编码设计

## 核心约束

- 数据级分卷：全局 payload = 所有文件的加密数据连续拼接
- 分卷 0（index segment）包含全部文件条目元数据 + 部分文件数据
- 后续分卷（data segment）不含文件条目，只有数据
- 所有分卷共享同一派生密钥（由 password + segSalt 派生）
- 索引分卷以 segSalt 作为 AES-CTR counter base，加密自身全部内容
- 数据分卷各有独立 segSalt，通过索引分卷中的 indexSalt 加密保护，用于同批校验
- 控制最终输出的 BMP 文件大小 ≤ 用户设定目标
- 不存 segmentStart/segmentSize/globalOffset，全部由 BMP 文件大小和 header 开销推算

---

## 加密模型

```
key = PBKDF2(password, segSalt, iter)
```

### 索引分卷

```
encMagic:        AES-CTR("F2P6", key, segSalt, 0, 128)    ← blockOff=0，取前 4B
encrypted 区:    AES-CTR(明文,   key, segSalt, 1, 128)    ← blockOff=1 起
                 内容: indexSalt + segCount + fileCount + fileEntries + data
```

### 数据分卷

```
encryptedSegSalt: AES-CTR(segSalt, key, indexSalt, 0, 128)
encMagic:         AES-CTR("F2P6", key, segSalt,  0, 128)
data:             AES-CTR(原文,    key, segSalt,  1, 128)  ← chunked
```

---

## Header 结构

### Index segment (segID=0)

```
offset  size  field              note
─────────────────────────────────────────────────────────────────
  0      4    magic=0x46325036   明文
  4      4    encMagic           4B，AES-CTR(key, segSalt, 0, 128) 前 4B
  8      8    segID=0            明文
 16     16    segSalt            16B 随机，PBKDF2 salt + AES-CTR counter base，明文
 32      4    iter               PBKDF2 迭代次数（默认 10000），明文
                                 ── 以下 AES-CTR(key, segSalt, 1, 128) 加密 ──
 36     16    indexSalt          用于加密数据分卷 segSalt
 52      8    segCount           总分卷数（含索引）
 60      8    fileCount          文件总数
 68      ?    fileEntries        文件条目列表
  ?      ?    data               索引分卷承载的文件数据
```

`fileEntries` 格式（与 data 共享同一 AES-CTR 流）：

```
[2B  nameLen][8B  dataLen][nB  name(UTF-8)]
```

重复 fileCount 次。nameLen + dataLen + name 在加密区原文中连续拼接，不独立加密。

### Data segment (segID>0)

```
offset  size  field              note
─────────────────────────────────────────────────────────────────
  0      4    magic=0x46325036   明文
  4      4    encMagic           4B，AES-CTR(key, segSalt, 0, 128) 前 4B
  8      8    segID=N            明文
 16     16    encryptedSegSalt   AES-CTR(segSalt, key, indexSalt, 0, 128)
                                 ── 以下 AES-CTR(key, segSalt, 1, 128) 加密 ──
 32      ?    data               加密文件数据（chunked 加密写入）
```

---

## BMP 文件布局

32-bit BGRA，BPP=4。每像素 4 字节，行步长 = 宽度 × 4（天然 4 字节对齐，无行填充）。

```
像素宽度 k = floor(sqrt(floor((8 + payloadSize) / BPP)))
像素高度 h = k
像素区大小 pds = k² × 4
尾巴大小 tailSize = (8 + payloadSize) − pds

bfSize (offset 2)  = 54 + pds    （只声明像素区）
biSizeImage (offset 34) = pds
实际文件大小        = 54 + 8 + payloadSize
```

尾巴数据紧跟在像素区之后，解码器越过 bfSize 线性读取。

---

## 分卷开销

| 分卷类型       | Header 明文 | Header 加密区       |
| -------------- | ----------- | ------------------- |
| index (segID=0)| 36B         | fileEntries + data  |
| data (segID>0) | 32B         | data                |

---

## 编码流程

### 1. 预计算分卷布局 (`precomputeSegments`)

```
payloadForTarget = targetBmpSize − 54 − 8
fixedMeta = 16 + 8 + 8                          // indexSalt + segCount + fileCount
fileListSize = Σ (2 + 8 + UTF-8(nameBytes))

indexCapacity = payloadForTarget − INDEX_HEADER_SIZE(36)
dataInIndex   = min(indexCapacity − fixedMeta − fileListSize, fileTotalData)
remaining     = fileTotalData − dataInIndex
dataPayload   = max(0, payloadForTarget − DATA_HEADER_SIZE(32))
dataSegCount  = ceil(remaining / dataPayload)
segCount      = 1 + dataSegCount
```

各分卷的 `dataOffset` 从 0 开始累加，索引分卷 dataOffset=0，后续数据分卷依次递增。

### 2. 顺序协调器 (`encodeSegmentsSequentially`)

所有下载请求（`/files?id=X&idx=0..N`）同时触发，但 SW 在协调器中逐个编码：

```
for each seg (0..N):
  等 request[idx] 到达
  创建 ReadableStream
  编码该分卷 BMP → push(row) → BMP 头部 + 像素行 + 尾巴
  resolve(request[idx], stream)
```

编码进度跨分卷统一上报，任务管理器显示为单个任务。

### 3. 索引分卷编码

```
key = PBKDF2(password, segSalt, iter)
encMagic = AES-CTR("F2P6", key, segSalt, 0, 128)[0..3]
encryptedSalt = AES-CTR(indexSalt, key, segSalt, 1, 128)[0..16]  // 加密区首 16B
plaintext = indexSalt + segCount(8B) + fileCount(8B) + fileEntries + extraData
encrypted = AES-CTR(plaintext, key, segSalt, 1, 128)
```

BMP 输出：header(54) → 像素区(wChunk encrypted) → pad + tail → closeStream

### 4. 数据分卷编码（chunked）

数据分卷生成独立 segSalt，chunked 加密写入保持 AES-CTR 计数器连续：

```
segSalt = random(16)
encryptedSegSalt = AES-CTR(segSalt, key, indexSalt, 0, 128)
encMagic = AES-CTR("F2P6", key, segSalt, 0, 128)[0..3]

blockOff = 1
offset = 0
while offset < seg.dataSize:
  take = min(CHUNK, remaining)
  data = readFileDataRange(files, seg.dataOffset + offset, take)
  encrypted = AES-CTR(data, key, segSalt, blockOff, 128)
  bmp.wChunk(encrypted)
  offset += take
  blockOff = 1 + offset/16
```

---

## 解码流程

### 1. 读取索引分卷

```
readF2P6Header(indexBlob):
  magic = buf[0..3]        // 验证 0x46325036
  encMagic = buf[4..7]
  segID = buf[8..15]       // 应为 0
  segSalt = buf[16..31]
  iter = buf[32..35]
  segType = "index"

key = PBKDF2(password, segSalt, iter)
verify: AES-CTR(encMagic, key, segSalt, 0, 128)[0..3] == "F2P6"

encAreaSize = bmpBlob.size − 54 − 8 − INDEX_HEADER_SIZE
encBuf = readPayload(meta, INDEX_HEADER_SIZE, encAreaSize)
decrypted = AES-CTR(encBuf, key, segSalt, 1, 128)

indexSalt = decrypted[0..15]
segCount = decrypted[16..23] (8B BE)
fileCount = decrypted[24..31] (8B BE)
解析 fileEntries (继续消费 decrypted)
dataInIndex = decrypted剩余字节数
```

### 2. 校验数据分卷

```
readF2P6Header(blob):
  segSalt = AES-CTR(encryptedSegSalt, key, indexSalt, 0, 128)[0..15]
  verify: AES-CTR(encMagic, key, segSalt, 0, 128)[0..3] == "F2P6"
  return { segID, segSalt, dataSize: totalPayload − DATA_HEADER_SIZE, dataOffset: DATA_HEADER_SIZE }
```

### 3. 构建全局数据映射

```
allSegments = []
if dataInIndex > 0:
  allSegments.push({ segID:0, globalStart:0,    globalEnd:dataInIndex, ... })

cum = dataInIndex
for each seg in dataSegments (sorted by segID):
  allSegments.push({ ..., globalStart:cum, globalEnd:cum+seg.dataSize })
  cum += seg.dataSize
```

### 4. 文件数据提取

每个文件的 `globalOffset` 在索引分卷解码时由文件大小累加计算。

非流式 (`extractFileData`)：一次读取该文件覆盖的所有分卷区间，解密后拼接。

流式 (`extractFileDataRange`)：按 64KB 块逐步读取指定文件内范围：

```
entry = indexInfo.entries[fileIdx]
fileStart = entry.globalOffset + rangeStart
fileEnd   = fileStart + rangeLen

for each seg in allSegments:
  if fileEnd <= seg.globalStart || fileStart >= seg.globalEnd → skip
  localStart = max(fileStart, seg.globalStart) − seg.globalStart

  encryptedStart = seg.isIndex ? INDEX_HEADER_SIZE(36) : DATA_HEADER_SIZE(32)
  streamBase     = seg.dataOffset − encryptedStart
  streamOffset   = streamBase + localStart
  alignedStream  = streamOffset & ~15         // 16B 对齐
  prePad         = streamOffset − alignedStream
  blockOff       = 1 + floor(alignedStream / 16)

  encrypted = readPayload(meta, encryptedStart + alignedStream, ceil(len/16)*16)
  decrypted = AES-CTR(encrypted, key, seg.segSalt, blockOff, 128)
  slice     = decrypted[prePad .. prePad+readLen]
```

---

## 流式下载路径

```
页面 → SW postMessage("f2p6-decode-group", {entries, keyRaw, indexBlob, ...})
SW  → pendingF2P6DecodeGroups.set(id, data)

页面 → triggerDownload("/files?id=" + gid + "&idx=" + i)
SW  → GET /files?id=X&idx=i → 查 pendingF2P6DecodeGroups
     → 派生 hash = SHA1(id + i)
     → 302 → /file/<hash>/<filename>
页面 iframe 跟随 302
SW  → GET /file/<hash>/<filename>
     → serveF2P6DecodeStream(id, i)
     → 构建 indexInfo + dataSegments
     → 按 64KB chunk 调 extractFileDataRange
     → ReadableStream 直出 Response
```

---

## 进度与取消

### 编码进度

分卷内有 chunk 粒度进度回调（每 64KB chunk 上报一次），跨分卷折算为整体百分比：

```
overall = (completedBefore + fraction × segInfo.dataSize) / totalData
```

每分卷完成后额外上报一次分卷级进度。

### 解码进度

解码流式下载中按 byte offset 上报：

```
pct = min(100, round(offset / fileSize × 100))
```

### 取消

- 编码：`job.cancelled` 在 `isCancelled` 回调中检查，编码中断后流 cancel
- 解码：ReadableStream `cancel()` 回调设 `job.cancelled`，流停止推送