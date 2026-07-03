// ═══════════════════════════════════════════════
// F2P6 编码器 — 分卷 BMP 编码
// ═══════════════════════════════════════════════
//
//  DRAFT.md 协议实现。编码流程：
//
//  1. precomputeSegments(files, targetBmpSize) → segInfo
//  2. 对每分卷：
//     - 创建 BMP 流 (buildBMPStream)
//     - push(bmp.header)  → 54B BMP 头先发
//     - 调 writeIndexPayload / writeDataPayload 写入 payload
//     - push(bmp.pad())   → 尾巴
//     - await bmp.flushAll()
//
//  注意：buildBMPStream 的 onRow 回调在 payload 写入期间同步触发。
//        调用者必须保证在写入 payload 前已推送 bmp.header。
//
// ═══════════════════════════════════════════════
"use strict";

import {
  buildBMPStream,
  aesEncrypt,
  deriveEncKey,
  readChunk,
  F2P6,
} from "../f2p-core.js";

const F2P6_MAGIC = F2P6;
const INDEX_HEADER_SIZE = 36; // magic(4) + encMagic(4) + segID(8) + segSalt(16) + iter(4)
const DATA_HEADER_SIZE = 32; // magic(4) + encMagic(4) + segID(8) + encryptedSegSalt(16)
// encMagic 取 AES-CTR 前 4B（blockOff=0），仅用于快速校验密码正确性，不做防碰撞/防伪造保证
// blockOff=0 固定留给 encMagic/encryptedSegSalt，blockOff>=1 为数据加密流
const BMP_HEADER_SIZE = 54;

/**
 * 给定目标 BMP 文件大小，计算 buildBMPStream 可用的 payload 字节数
 * BMP 实际大小 = 54 + (8 + payloadSize)
 */
function payloadForTarget(targetBmpSize) {
  const ps = targetBmpSize - BMP_HEADER_SIZE;
  if (ps <= 8) return 0;
  return ps - 8;
}

export { payloadForTarget, INDEX_HEADER_SIZE, DATA_HEADER_SIZE, F2P6_MAGIC };

/**
 * 预计算分卷布局
 */
export function precomputeSegments(files, targetBmpSize) {
  // 文件条目列表大小: [2B nameLen][8B dataLen][nB name]
  let fileListSize = 0;
  const nameBufs = [];
  for (const f of files) {
    const nb = new TextEncoder().encode(f.name);
    nameBufs.push(nb);
    fileListSize += 2 + 8 + nb.length;
  }

  const fileTotalData = files.reduce((s, f) => s + f.size, 0);
  const fixedMeta = 16 + 8 + 8; // indexSalt + segCount + fileCount

  // targetBmpSize <= 0 = 单 BMP（不分卷），全部数据装进索引分卷
  if (targetBmpSize <= 0) {
    const segCount = 1;
    const segments = [
      {
        segID: 0,
        type: "index",
        headerSize: INDEX_HEADER_SIZE,
        encryptedMetaSize: fixedMeta + fileListSize,
        dataSize: fileTotalData,
        dataOffset: 0,
        payloadSize:
          INDEX_HEADER_SIZE + fixedMeta + fileListSize + fileTotalData,
      },
    ];
    return {
      segCount,
      fileListSize,
      fileTotalData,
      segments,
      targetBmpSize,
      nameBufs,
    };
  }

  const indexCapacity = payloadForTarget(targetBmpSize) - INDEX_HEADER_SIZE;

  let dataInIndex = 0;
  if (indexCapacity > fixedMeta + fileListSize) {
    dataInIndex = indexCapacity - fixedMeta - fileListSize;
    if (dataInIndex > fileTotalData) dataInIndex = fileTotalData;
  }

  const remainingData = fileTotalData - dataInIndex;
  const dataPayload = Math.max(
    0,
    payloadForTarget(targetBmpSize) - DATA_HEADER_SIZE,
  );
  let dataSegCount = 0;
  if (dataPayload > 0 && remainingData > 0) {
    dataSegCount = Math.ceil(remainingData / dataPayload);
  }

  const segCount = 1 + dataSegCount;

  // 安全兜底：文件列表必须完整装入索引分卷
  const indexPayloadSize = INDEX_HEADER_SIZE + fixedMeta + fileListSize;
  if (indexPayloadSize > payloadForTarget(targetBmpSize)) {
    throw new Error(
      "文件列表装不下索引分卷，至少需要 " +
        Math.ceil((indexPayloadSize + 54 + 8) / 1048576) +
        " MB",
    );
  }

  // 构建分卷列表
  const segments = [];
  let gOff = 0;

  segments.push({
    segID: 0,
    type: "index",
    headerSize: INDEX_HEADER_SIZE,
    encryptedMetaSize: fixedMeta + fileListSize,
    dataSize: dataInIndex,
    dataOffset: 0,
    payloadSize: INDEX_HEADER_SIZE + fixedMeta + fileListSize + dataInIndex,
  });
  gOff += dataInIndex;

  for (let i = 1; i < segCount; i++) {
    const rem = fileTotalData - gOff;
    const ds = Math.min(rem, dataPayload);
    segments.push({
      segID: i,
      type: "data",
      headerSize: DATA_HEADER_SIZE,
      encryptedMetaSize: 0,
      dataSize: ds,
      dataOffset: gOff,
      payloadSize: DATA_HEADER_SIZE + ds,
    });
    gOff += ds;
  }

  return {
    segCount,
    fileListSize,
    fileTotalData,
    segments,
    targetBmpSize,
    nameBufs,
  };
}

// ── 死代码已删除：buildFileEntries（被 buildFileEntriesFromFiles 替代）

/**
 * 调用前必须已 push(bmp.header)，函数通过 bmp.w* 写入 payload。
 *
 * @param {object} bmp       - buildBMPStream 返回值
 * @param {object} segInfo   - precomputeSegments 返回的 segments[0]
 * @param {object} segParams - 见返回值
 * @param {Uint8Array} [extraData] - 索引分卷包含的部分文件数据
 */
export async function writeIndexPayload(bmp, segInfo, segParams, extraData) {
  const { encKey, segSalt, iter, indexSalt, segCount, encMagic } = segParams;

  // 明文头 (36B)
  bmp.w32(F2P6_MAGIC);
  bmp.wChunk(encMagic);
  bmp.w64(0); // segID
  bmp.wChunk(segSalt);
  bmp.w32(iter);

  // 构建加密区原文
  const parts = [];

  // indexSalt (16B)
  parts.push(indexSalt);

  // segCount (8B BE)
  const scBuf = new Uint8Array(8);
  let sc = segCount;
  for (let i = 7; i >= 0; i--) {
    scBuf[i] = sc & 0xff;
    sc >>>= 8;
  }
  parts.push(scBuf);

  // fileCount (8B BE)
  const fcBuf = new Uint8Array(8);
  let fc = segParams.fileCount;
  for (let i = 7; i >= 0; i--) {
    fcBuf[i] = fc & 0xff;
    fc >>>= 8;
  }
  parts.push(fcBuf);

  // fileList
  parts.push(segParams.fileEntries);

  // 索引分卷中的数据部分
  if (extraData && extraData.length > 0) {
    parts.push(extraData);
  }

  // 合并
  const total = parts.reduce((s, p) => s + p.length, 0);
  const plaintext = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    plaintext.set(p, off);
    off += p.length;
  }

  // 加密 (blockOff=1)
  const encrypted = await aesEncrypt(plaintext, encKey, segSalt, 1, 128);
  bmp.wChunk(encrypted);
}

/**
 * 准备索引分卷加密参数 (不涉及 BMP 流)
 */
export async function prepareIndexParams(
  files,
  password,
  segInfo,
  nameBufs,
  extraDataSize,
) {
  const segSalt = crypto.getRandomValues(new Uint8Array(16));
  const iter = 10000;
  const encKey = await deriveEncKey(password, segSalt, iter);

  // encMagic
  const emFull = await aesEncrypt(
    new Uint8Array([0x46, 0x32, 0x50, 0x36]),
    encKey,
    segSalt,
    0,
    128,
  );
  const encMagic = emFull.subarray(0, 4);

  const indexSalt = crypto.getRandomValues(new Uint8Array(16));
  const fileEntries = buildFileEntriesFromFiles(files, nameBufs);

  return {
    encKey,
    segSalt,
    iter,
    indexSalt,
    encMagic,
    fileEntries,
    segCount: segInfo.segCount || 1,
    fileCount: files.length,
  };
}

/**
 * 写入数据分卷 payload (不含 BMP header)
 *
 * @param {object} bmp     - buildBMPStream 返回值
 * @param {object} segInfo - segments[i]
 * @param {CryptoKey} encKey
 * @param {Uint8Array} indexSalt
 * @param {Uint8Array} data  - 该分卷的原始文件数据（未加密）
 */
export async function writeDataPayload(bmp, segInfo, encKey, indexSalt, data) {
  // 生成数据分卷独立 segSalt
  const segSalt = crypto.getRandomValues(new Uint8Array(16));

  // encryptedSegSalt: AES-CTR(segSalt, key, indexSalt, 0, 128)
  const essFull = await aesEncrypt(segSalt, encKey, indexSalt, 0, 128);
  const encryptedSegSalt = essFull.subarray(0, 16);

  // encMagic: AES-CTR("F2P6", key, segSalt, 0, 128)
  const emFull = await aesEncrypt(
    new Uint8Array([0x46, 0x32, 0x50, 0x36]),
    encKey,
    segSalt,
    0,
    128,
  );
  const encMagic = emFull.subarray(0, 4);

  // 明文头 (32B)
  bmp.w32(F2P6_MAGIC);
  bmp.wChunk(encMagic);
  bmp.w64(segInfo.segID);
  bmp.wChunk(encryptedSegSalt);

  // 加密数据
  const encrypted = await aesEncrypt(data, encKey, segSalt, 1, 128);
  bmp.wChunk(encrypted);
}

// ── 中层编码函数（供 SW 调用）──

/**
 * 从多个文件中按全局偏移读取数据
 */
export async function readFileDataRange(files, offset, length) {
  let cum = 0;
  const parts = [];
  let remaining = length;
  for (const f of files) {
    if (remaining <= 0) break;
    if (offset >= cum + f.size) {
      cum += f.size;
      continue;
    }
    const fileStart = Math.max(0, offset - cum);
    const readLen = Math.min(f.size - fileStart, remaining);
    const buf = await readChunk(f, fileStart, fileStart + readLen, readLen);
    parts.push(buf);
    remaining -= readLen;
    offset += readLen;
    cum += f.size;
  }
  if (parts.length === 0) return new Uint8Array(0);
  if (parts.length === 1) return parts[0];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const result = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    result.set(p, off);
    off += p.length;
  }
  return result;
}

/**
 * 构建文件条目缓冲区
 */
export function buildFileEntriesFromFiles(files, nameBufs) {
  const nbArr = nameBufs || files.map((f) => new TextEncoder().encode(f.name));
  const total = nbArr.reduce((s, nb) => s + 2 + 8 + nb.length, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (let i = 0; i < files.length; i++) {
    const nb = nbArr[i];
    const nl = nb.length;
    const sz = files[i].size;
    buf[off++] = (nl >>> 8) & 0xff;
    buf[off++] = nl & 0xff;
    for (let j = 7; j >= 0; j--) buf[off++] = (sz >>> (j * 8)) & 0xff;
    buf.set(nb, off);
    off += nl;
  }
  return buf;
}

/**
 * 编码索引分卷 BMP，返回 Promise 在流结束时 resolve
 *
 * @param {object}   seg
 * @param {object}   job          - SW job 对象，含 encKey/segSalt/iter/indexSalt/files
 * @param {function} push
 * @param {function} closeStream
 * @param {object}   [opts]
 * @param {function} [opts.isCancelled]  - () => boolean
 * @param {function} [opts.onProgress]   - (fraction) => void, 0..1
 */
export async function encodeIndexSegment(seg, job, push, closeStream, opts) {
  if (seg.segID !== 0)
    throw Error("encodeIndexSegment 只接受索引分卷 (segID=0)");
  const { files, encKey, segSalt, iter, indexSalt, encMagic, fileEntries } =
    job;
  const payloadSize = seg.payloadSize;

  opts?.onProgress?.(0);

  const bmp = buildBMPStream(payloadSize, (row) => push(row));
  push(bmp.header);
  if (opts?.isCancelled?.()) return;
  opts?.onProgress?.(0.05);

  // ── 明文头 (36B) ──
  bmp.w32(F2P6_MAGIC);
  bmp.wChunk(encMagic);
  bmp.w64(0);
  bmp.wChunk(segSalt);
  bmp.w32(iter);

  // 构建加密区元数据：indexSalt(16) + segCount(8) + fileCount(8) + fileEntries(N)
  const segInfo = job.segInfo;
  const scBuf = new Uint8Array(8);
  for (let i = 7, sc = segInfo.segCount; i >= 0; i--) {
    scBuf[i] = sc & 0xff;
    sc >>>= 8;
  }
  const fcBuf = new Uint8Array(8);
  for (let i = 7, fc = files.length; i >= 0; i--) {
    fcBuf[i] = fc & 0xff;
    fc >>>= 8;
  }

  const metaSize = 32 + fileEntries.length;
  const metaPlain = new Uint8Array(metaSize);
  metaPlain.set(indexSalt, 0);
  metaPlain.set(scBuf, 16);
  metaPlain.set(fcBuf, 24);
  metaPlain.set(fileEntries, 32);

  const metaEnc = await aesEncrypt(metaPlain, encKey, segSalt, 1, 128);
  bmp.wChunk(metaEnc);
  if (opts?.isCancelled?.()) return;
  opts?.onProgress?.(0.15);

  // ── 数据区：分块加密，保持 AES-CTR 流连续 ──
  // 元数据占用 AES-CTR blockOff=1 起的 metaSize 字节
  // 数据从 blockOff=1+floor(metaSize/16) 的 prePad=metaSize%16 偏移处接续
  if (seg.dataSize > 0) {
    const CHUNK = (job.chunkSize || 64) * 1024;
    const prePad = metaSize % 16;
    const baseBlockOff = 1 + Math.floor(metaSize / 16);
    let remaining = seg.dataSize;
    let dataOff = 0;

    while (remaining > 0) {
      if (opts?.isCancelled?.()) return;

      const take = Math.min(remaining, CHUNK);
      const data = await readFileDataRange(files, dataOff, take);
      if (data.length < take) throw Error("读取文件数据不足 @" + dataOff);

      const curBlockOff = baseBlockOff + Math.floor(dataOff / 16);
      if (prePad > 0) {
        // 元数据非 16B 对齐时，每块都需要 prePad 填充
        // 由于 CHUNK 是 16 的倍数，每块的 prePad 相同
        const padded = new Uint8Array(prePad + data.length);
        padded.set(data, prePad);
        const enc = await aesEncrypt(padded, encKey, segSalt, curBlockOff, 128);
        bmp.wChunk(enc.subarray(prePad));
      } else {
        const enc = await aesEncrypt(data, encKey, segSalt, curBlockOff, 128);
        bmp.wChunk(enc);
      }

      dataOff += take;
      remaining -= take;
      opts?.onProgress?.(0.15 + 0.75 * (dataOff / seg.dataSize));
    }
  }

  if (opts?.isCancelled?.()) return;
  opts?.onProgress?.(0.9);

  const tail = bmp.pad();
  await bmp.flushAll();
  if (tail && tail.length) push(tail);
  closeStream();
  opts?.onProgress?.(1);
}

/**
 * 编码数据分卷 BMP（chunked 加密，支持进度和取消）
 *
 * @param {object}   seg
 * @param {object}   job          - SW job 对象
 * @param {function} push
 * @param {function} closeStream
 * @param {object}   [opts]
 * @param {function} [opts.isCancelled]  - () => boolean
 * @param {function} [opts.onProgress]   - (fraction) => void, 0..1
 */
export async function encodeDataSegment(seg, job, push, closeStream, opts) {
  const { files, encKey, indexSalt } = job;
  const payloadSize = seg.payloadSize;
  const bmp = buildBMPStream(payloadSize, (row) => push(row));
  push(bmp.header);

  opts?.onProgress?.(0);

  // 生成数据分卷独立 segSalt
  const segSalt = crypto.getRandomValues(new Uint8Array(16));

  const essFull = await aesEncrypt(segSalt, encKey, indexSalt, 0, 128);
  const encryptedSegSalt = essFull.subarray(0, 16);

  const emFull = await aesEncrypt(
    new Uint8Array([0x46, 0x32, 0x50, 0x36]),
    encKey,
    segSalt,
    0,
    128,
  );
  const encMagic = emFull.subarray(0, 4);

  if (opts?.isCancelled?.()) return;
  opts?.onProgress?.(0.05);

  // 明文头 (32B)
  bmp.w32(F2P6_MAGIC);
  bmp.wChunk(encMagic);
  bmp.w64(seg.segID);
  bmp.wChunk(encryptedSegSalt);

  // Chunked 数据读取 + 加密 + 写入，保持 AES-CTR 计数器连续
  const CHUNK = (job.chunkSize || 64) * 1024;
  let remaining = seg.dataSize;
  let offset = 0;
  while (remaining > 0) {
    if (opts?.isCancelled?.()) return;

    const take = Math.min(remaining, CHUNK);
    const data = await readFileDataRange(files, seg.dataOffset + offset, take);
    if (data.length < take) throw Error("读取文件数据不足 @" + offset);

    const blockOff = 1 + Math.floor(offset / 16);
    const encrypted = await aesEncrypt(data, encKey, segSalt, blockOff, 128);
    bmp.wChunk(encrypted);

    offset += take;
    remaining -= take;

    opts?.onProgress?.(0.05 + 0.9 * (offset / seg.dataSize));
  }

  if (opts?.isCancelled?.()) return;
  opts?.onProgress?.(0.95);

  const tail = bmp.pad();
  await bmp.flushAll();
  if (tail && tail.length) push(tail);
  closeStream();
  opts?.onProgress?.(1);
}
