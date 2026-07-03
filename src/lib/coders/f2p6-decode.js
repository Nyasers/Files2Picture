// ═══════════════════════════════════════════════
// F2P6 解码器 — 分卷 BMP 解码
// ═══════════════════════════════════════════════
"use strict";

import {
  readBmpHeader,
  readPayload,
  deriveEncKey,
  aesDecrypt,
} from "../f2p-core.js";

import {
  F2P6_MAGIC,
  INDEX_HEADER_SIZE,
  DATA_HEADER_SIZE,
} from "./f2p6-encode.js";

// ── 从 BMP blob 读取 F2P6 明文头 ──

export async function readF2P6Header(bmpBlob) {
  const meta = await readBmpHeader(bmpBlob);

  const buf = await readPayload(meta, 0, 20);
  if (buf.length < 20) throw Error("BMP 数据不足");

  const magic = (buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3];
  if (magic !== F2P6_MAGIC) throw Error("不是 F2P6 格式");

  const encMagic = buf.subarray(4, 8);
  let segID = 0;
  for (let i = 0; i < 8; i++) segID = (segID << 8) | buf[8 + i];

  if (segID === 0) {
    const buf2 = await readPayload(meta, 16, 20);
    if (buf2.length < 20) throw Error("BMP 数据不足 (索引头)");
    const segSalt = buf2.subarray(0, 16);
    const iter =
      (buf2[16] << 24) | (buf2[17] << 16) | (buf2[18] << 8) | buf2[19];
    return {
      magic,
      encMagic,
      segID: 0,
      segSalt,
      iter,
      encryptedSegSalt: null,
      bmpMeta: meta,
      segType: "index",
    };
  }

  const buf2 = await readPayload(meta, 16, 16);
  if (buf2.length < 16) throw Error("BMP 数据不足 (数据头)");
  return {
    magic,
    encMagic,
    segID,
    segSalt: null,
    iter: null,
    encryptedSegSalt: buf2.subarray(0, 16),
    bmpMeta: meta,
    segType: "data",
  };
}

// ── 解码索引分卷 ──

export async function decodeIndexSegment(bmpBlob, password, chunkSizeKB) {
  const hdr = await readF2P6Header(bmpBlob);
  if (hdr.segType !== "index") throw Error("不是索引分卷");

  const { segSalt, iter, encMagic, bmpMeta } = hdr;
  const key = await deriveEncKey(password, segSalt, iter, true);

  // 校验 encMagic
  const md = await aesDecrypt(encMagic, key, segSalt, 0, 128);
  if (md[0] !== 0x46 || md[1] !== 0x32 || md[2] !== 0x50 || md[3] !== 0x36)
    throw Error("密码错误");

  // BMP payload 总大小（从文件大小推算，含尾巴）
  const totalPayload = bmpBlob.size - 54 - 8;
  const encAreaSize = Math.max(0, totalPayload - INDEX_HEADER_SIZE);

  // 流式读取加密区：分块解密，只解析文件条目就停，不加载数据部分进内存
  const CHUNK = (chunkSizeKB || 64) * 1024;
  let decrypted = new Uint8Array(0);
  let metaRead = 0;
  let off = 0;
  let fileCount = 0;
  const entries = [];

  while (metaRead < encAreaSize) {
    const take = Math.min(CHUNK, encAreaSize - metaRead);
    const encrypted = await readPayload(
      bmpMeta,
      INDEX_HEADER_SIZE + metaRead,
      take,
    );
    const blockOff = 1 + Math.floor(metaRead / 16);
    const decChunk = await aesDecrypt(encrypted, key, segSalt, blockOff, 128);

    // 累积到缓冲区并继续解析
    const newBuf = new Uint8Array(decrypted.length + decChunk.length);
    newBuf.set(decrypted);
    newBuf.set(decChunk, decrypted.length);
    decrypted = newBuf;
    metaRead += take;

    // 逐段解析文件条目
    if (off < 32 && decrypted.length >= 32) {
      off = 32; // indexSalt(16) + segCount(8) + fileCount(8)
    }
    if (off === 32 && fileCount === 0 && decrypted.length >= 32) {
      for (let i = 0; i < 8; i++)
        fileCount = (fileCount << 8) | decrypted[24 + i];
    }
    if (fileCount > 0) {
      while (entries.length < fileCount) {
        if (off + 2 > decrypted.length) break;
        const nameLen = (decrypted[off] << 8) | decrypted[off + 1];
        if (off + 10 + nameLen > decrypted.length) break;

        let dataLen = 0;
        for (let j = 0; j < 8; j++)
          dataLen = (dataLen << 8) | decrypted[off + 2 + j];
        const name = new TextDecoder().decode(
          decrypted.subarray(off + 10, off + 10 + nameLen),
        );
        entries.push({ name, size: dataLen });
        off += 10 + nameLen;
      }
      if (entries.length >= fileCount) break;
    }
  }

  // 索引分卷元数据结束偏移，用于推算数据部分位置
  const indexSalt = decrypted.subarray(0, 16);
  let segCount = 0;
  for (let i = 0; i < 8; i++) segCount = (segCount << 8) | decrypted[16 + i];

  // dataInIndex = 从 BMP 总大小推算的加密区长度 − 元数据长度
  const dataInIndex = Math.max(0, encAreaSize - off);
  const indexDataPayloadOffset = INDEX_HEADER_SIZE + off;

  // 计算全局偏移
  let acc = 0;
  for (const e of entries) {
    e.globalOffset = acc;
    acc += e.size;
  }

  return {
    entries,
    key,
    indexSalt,
    segSalt,
    iter,
    segCount,
    fileCount,
    bmpMeta,
    dataInIndex,
    indexDataPayloadOffset,
  };
}

// ── 解码数据分卷 ──

export async function verifyDataSegment(bmpBlob, key, indexSalt) {
  const hdr = await readF2P6Header(bmpBlob);
  if (hdr.segType !== "data") throw Error("不是数据分卷");

  // 解密 encryptedSegSalt → segSalt（AES-CTR 对称）
  const segSaltBuf = await aesDecrypt(
    hdr.encryptedSegSalt,
    key,
    indexSalt,
    0,
    128,
  );
  const segSalt = segSaltBuf.subarray(0, 16);

  // 校验 encMagic
  const md = await aesDecrypt(hdr.encMagic, key, segSalt, 0, 128);
  if (md[0] !== 0x46 || md[1] !== 0x32 || md[2] !== 0x50 || md[3] !== 0x36)
    throw Error(
      "分卷校验失败: segID=" + hdr.segID + " — 不属于同一批次或数据损坏",
    );

  const meta = hdr.bmpMeta;
  const totalPayload = bmpBlob.size - 54 - 8;
  const dataSize = Math.max(0, totalPayload - DATA_HEADER_SIZE);

  return {
    segID: hdr.segID,
    segSalt,
    dataSize,
    dataOffset: DATA_HEADER_SIZE,
    bmpMeta: meta,
  };
}

// ── 分卷映射构建（extractFileData / extractFileDataRange 共用）──

function buildSegmentMap(indexInfo, dataSegments) {
  const { dataInIndex, indexDataPayloadOffset, bmpMeta, segSalt } = indexInfo;
  const allSegments = [];
  if (dataInIndex > 0) {
    allSegments.push({
      segID: 0,
      globalStart: 0,
      globalEnd: dataInIndex,
      dataOffset: indexDataPayloadOffset,
      segSalt,
      bmpMeta,
      isIndex: true,
    });
  }
  const sortedSegs = [...dataSegments].sort((a, b) => a.segID - b.segID);
  let cum = dataInIndex;
  for (const seg of sortedSegs) {
    allSegments.push({
      ...seg,
      globalStart: cum,
      globalEnd: cum + seg.dataSize,
    });
    cum += seg.dataSize;
  }
  return allSegments;
}

// ── 文件数据提取 ──

/**
 * 在分卷映射上执行 AES-CTR 对齐解密，将命中范围内的数据写入目标缓冲区
 *
 * @param {Uint8Array} result     - 目标缓冲区
 * @param {number}     resultOff  - 写入起始偏移
 * @param {CryptoKey}  key
 * @param {Array}      allSegments - buildSegmentMap 返回值
 * @param {number}     rangeStart - 全局起始偏移
 * @param {number}     rangeEnd   - 全局结束偏移
 * @returns {number} 实际写入的字节数
 */
async function _decryptRange(
  result,
  resultOff,
  key,
  allSegments,
  rangeStart,
  rangeEnd,
) {
  for (const seg of allSegments) {
    if (rangeEnd <= seg.globalStart) break;
    if (rangeStart >= seg.globalEnd) continue;

    const rs = Math.max(rangeStart, seg.globalStart);
    const re = Math.min(rangeEnd, seg.globalEnd);
    const len = re - rs;
    const localStart = rs - seg.globalStart;

    const encryptedStart = seg.isIndex ? INDEX_HEADER_SIZE : DATA_HEADER_SIZE;
    const streamBase = seg.dataOffset - encryptedStart;
    const streamOffset = streamBase + localStart;
    const alignedStream = streamOffset & ~15;
    const prePad = streamOffset - alignedStream;
    const alignedLen = Math.ceil((prePad + len) / 16) * 16;
    const blockOff = 1 + Math.floor(alignedStream / 16);

    const encrypted = await readPayload(
      seg.bmpMeta,
      encryptedStart + alignedStream,
      alignedLen,
    );
    const decrypted = await aesDecrypt(
      encrypted,
      key,
      seg.segSalt,
      blockOff,
      128,
    );

    const slice = decrypted.subarray(prePad, prePad + len);
    result.set(slice, resultOff);
    resultOff += slice.length;
  }
  return resultOff;
}

/**
 * 提取单个文件的解密数据。
 * 包含索引分卷中的数据部分。
 *
 * @param {object} indexInfo    - decodeIndexSegment 的返回值
 * @param {Array}  dataSegments - verifyDataSegment 返回值数组
 * @param {number} fileIdx
 * @returns {Promise<Uint8Array>}
 */
export async function extractFileData(indexInfo, dataSegments, fileIdx) {
  const entry = indexInfo.entries[fileIdx];
  if (!entry) throw Error("文件索引无效: " + fileIdx);
  if (entry.size === 0) return new Uint8Array(0);

  const { key } = indexInfo;
  const allSegments = buildSegmentMap(indexInfo, dataSegments);
  const result = new Uint8Array(entry.size);
  const CHUNK = 65536;
  let written = 0;
  let fileOff = 0;

  while (fileOff < entry.size) {
    const take = Math.min(CHUNK, entry.size - fileOff);
    const rangeStart = entry.globalOffset + fileOff;
    written = await _decryptRange(
      result,
      written,
      key,
      allSegments,
      rangeStart,
      rangeStart + take,
    );
    fileOff += take;
  }
  return written < entry.size ? result.subarray(0, written) : result;
}

/**
 * 提取单个文件的指定字节范围（用于流式下载）
 *
 * @param {object} indexInfo
 * @param {Array}  dataSegments
 * @param {number} fileIdx
 * @param {number} [rangeStart] - 不传则返回全部
 * @param {number} [rangeLen]
 * @returns {Promise<Uint8Array>}
 */
export async function extractFileDataRange(
  indexInfo,
  dataSegments,
  fileIdx,
  rangeStart,
  rangeLen,
) {
  if (rangeStart == null)
    return extractFileData(indexInfo, dataSegments, fileIdx);

  const entry = indexInfo.entries[fileIdx];
  if (!entry) throw Error("文件索引无效: " + fileIdx);
  if (rangeStart < 0 || rangeLen <= 0) return new Uint8Array(0);

  const { key } = indexInfo;

  const fileEnd = entry.globalOffset + entry.size;
  const readStart = entry.globalOffset + rangeStart;
  const readEnd = Math.min(entry.globalOffset + rangeStart + rangeLen, fileEnd);
  const readLen = readEnd - readStart;
  if (readLen <= 0) return new Uint8Array(0);

  const allSegments = buildSegmentMap(indexInfo, dataSegments);

  const result = new Uint8Array(readLen);
  const written = await _decryptRange(
    result,
    0,
    key,
    allSegments,
    readStart,
    readEnd,
  );
  return written < readLen ? result.subarray(0, written) : result;
}
