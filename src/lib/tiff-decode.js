// ═══════════════════════════════════════════════
// 标准 TIFF 解码器（魔数 42，零私有 tag）
// 元数据从 IFD#0 的像素数据中解析
// ═══════════════════════════════════════════════

import {
  TIFF_HDR_SIZE, IFD_ENTRY,
  typeSize, INDEX_HEADER, indexEntrySize,
  T_IMAGE_WIDTH, T_IMAGE_LENGTH,
  T_STRIP_OFFSETS, T_STRIP_BYTE_COUNTS,
} from "./tiff-common.js";

export async function detectTiff(blob) {
  try {
    const buf = await blob.slice(0, 4).arrayBuffer();
    const v = new DataView(buf);
    const b0 = v.getUint8(0), b1 = v.getUint8(1);
    if (b0 !== 0x49 && b0 !== 0x4d) return null;
    if ((b0 === 0x49 && b1 !== 0x49) || (b0 === 0x4d && b1 !== 0x4d)) return null;
    const le = b0 === 0x49;
    const magic = v.getUint16(2, le);
    if (magic !== 42) return null;
    const hdr = await blob.slice(0, 8).arrayBuffer();
    return { le, ifd0Off: new DataView(hdr).getUint32(4, le) };
  } catch { return null; }
}

export async function readExternal(blob, off, size) {
  return new Uint8Array(await blob.slice(off, off + size).arrayBuffer());
}

// 读 IFD 标签
export async function readIFD(blob, offset, le) {
  const cntBuf = await blob.slice(offset, offset + 2).arrayBuffer();
  const entryCount = new DataView(cntBuf).getUint16(0, le);
  const entryBytes = entryCount * IFD_ENTRY;
  const ifdBuf = await blob.slice(offset + 2, offset + 2 + entryBytes).arrayBuffer();
  const dv = new DataView(ifdBuf);

  const tags = new Map();
  for (let i = 0; i < entryCount; i++) {
    const eo = i * IFD_ENTRY;
    const tag = dv.getUint16(eo, le);
    const type = dv.getUint16(eo + 2, le);
    const count = dv.getUint32(eo + 4, le);
    const valOff = dv.getUint32(eo + 8, le);
    const ts = typeSize[type];
    const ds = ts ? count * ts : 0;
    if (ds <= 4 && ts) {
      const raw = new Uint8Array(4);
      for (let j = 0; j < 4; j++) raw[j] = dv.getUint8(eo + 8 + j);
      tags.set(tag, { type, count, inline: true, data: raw.subarray(0, ds), size: ds, dataOffset: valOff });
    } else {
      tags.set(tag, { type, count, inline: false, dataOffset: valOff, size: ds });
    }
  }

  const nextOff = offset + 2 + entryBytes;
  const nextBuf = await blob.slice(nextOff, nextOff + 4).arrayBuffer();
  return { tags, nextIFD: new DataView(nextBuf).getUint32(0, le) };
}

function getTagVal(tags, tagId) {
  const t = tags.get(tagId);
  if (!t) return null;
  if (t.inline) return new DataView(t.data.buffer, t.data.byteOffset, t.data.length).getUint32(0, true);
  return null;
}

// ── 从像素数据解析索引表 ──

export function parseIndexTable(pixelData) {
  const dv = new DataView(pixelData.buffer, pixelData.byteOffset, pixelData.length);
  const magic = dv.getUint32(0, true);
  if (magic !== 0x46325034) return null; // "F2P4"
  const N = dv.getUint32(8, true);
  if (N < 1 || N > 10000) return null;

  const salt = new Uint8Array(16);
  for (let j = 0; j < 16; j++) salt[j] = dv.getUint8(12 + j);
  const iter = dv.getUint32(28, true);
  const magicCheck = new Uint8Array(4);
  for (let j = 0; j < 4; j++) magicCheck[j] = dv.getUint8(32 + j);

  const entries = [];
  let off = INDEX_HEADER;
  for (let i = 0; i < N; i++) {
    const ifdOff = dv.getUint32(off, true); off += 4;
    const nl = dv.getUint16(off, true); off += 2;
    const nameBytes = new Uint8Array(nl);
    for (let j = 0; j < nl; j++) nameBytes[j] = dv.getUint8(off + j);
    off += nl;
    const fileSize = dv.getUint32(off, true); off += 4;
    const nonce = new Uint8Array(12);
    for (let j = 0; j < 12; j++) nonce[j] = dv.getUint8(off + j);
    off += 12;

    entries.push({
      name: new TextDecoder().decode(nameBytes),
      size: fileSize,
      nonce,
      ifdOffset: ifdOff,
    });
  }
  return { entries, salt, iter, magicCheck };
}

// ── 容器解码 ──

export async function decodeContainer(blob) {
  const info = await detectTiff(blob);
  if (!info) return null;

  const { le, ifd0Off } = info;
  const ifd0 = await readIFD(blob, ifd0Off, le);
  const tags = ifd0.tags;

  const sOff = getTagVal(tags, T_STRIP_OFFSETS);
  const sSize = getTagVal(tags, T_STRIP_BYTE_COUNTS);
  if (sOff === null || sSize === null || sSize > 10 * 1024 * 1024) return null;

  // 读第 0 页像素数据 → 索引表
  const pixelData = await readExternal(blob, sOff, sSize);
  const parsed = parseIndexTable(pixelData);
  if (!parsed) return null;
  const { entries, salt, iter, magicCheck } = parsed;

  // 对每个文件条目，补上 strip 偏移和尺寸
  for (const e of entries) {
    const fIfd = await readIFD(blob, e.ifdOffset, le);
    const ft = fIfd.tags;
    e.stripOffset = getTagVal(ft, T_STRIP_OFFSETS) || 0;
    e.stripSize = getTagVal(ft, T_STRIP_BYTE_COUNTS) || 0;
  }

  return {
    entries,
    N: entries.length,
    isF2P4: true,
    salt,
    iter,
    magicCheck,
  };
}