// ═══════════════════════════════════════════════
// 标准 TIFF 解码器（魔数 42，零私有 tag）
// ═══════════════════════════════════════════════

import {
  TIFF_HDR_SIZE,
  IFD_ENTRY,
  typeSize,
  INDEX_HEADER,
  META_HEADER,
  T_STRIP_OFFSETS,
  T_STRIP_BYTE_COUNTS,
} from "./tiff-common.js";
import { deriveEncKey, aesDecrypt } from "./f2p-core.js";

export async function detectTiff(blob) {
  try {
    const buf = await blob.slice(0, 4).arrayBuffer();
    const v = new DataView(buf);
    const b0 = v.getUint8(0),
      b1 = v.getUint8(1);
    if (b0 !== 0x49 && b0 !== 0x4d) return null;
    if ((b0 === 0x49 && b1 !== 0x49) || (b0 === 0x4d && b1 !== 0x4d))
      return null;
    const le = b0 === 0x49;
    if (v.getUint16(2, le) !== 42) return null;
    const hdr = await blob.slice(0, 8).arrayBuffer();
    return { le, ifd0Off: new DataView(hdr).getUint32(4, le) };
  } catch {
    return null;
  }
}

export async function readExternal(blob, off, size) {
  return new Uint8Array(await blob.slice(off, off + size).arrayBuffer());
}

export async function readIFD(blob, offset, le) {
  const cntBuf = await blob.slice(offset, offset + 2).arrayBuffer();
  const entryCount = new DataView(cntBuf).getUint16(0, le);
  const entryBytes = entryCount * IFD_ENTRY;
  const ifdBuf = await blob
    .slice(offset + 2, offset + 2 + entryBytes)
    .arrayBuffer();
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
      tags.set(tag, {
        type,
        count,
        inline: true,
        data: raw.subarray(0, ds),
        size: ds,
        dataOffset: valOff,
      });
    } else {
      tags.set(tag, {
        type,
        count,
        inline: false,
        dataOffset: valOff,
        size: ds,
      });
    }
  }
  const nextOff = offset + 2 + entryBytes;
  const nextBuf = await blob.slice(nextOff, nextOff + 4).arrayBuffer();
  return { tags, nextIFD: new DataView(nextBuf).getUint32(0, le) };
}

function getTagVal(tags, tagId) {
  const t = tags.get(tagId);
  if (!t) return null;
  if (t.inline)
    return new DataView(
      t.data.buffer,
      t.data.byteOffset,
      t.data.length,
    ).getUint32(0, true);
  return null;
}

// ── 解析明文头 ──

export function parseIndexHeader(pixelData) {
  const dv = new DataView(
    pixelData.buffer,
    pixelData.byteOffset,
    pixelData.length,
  );
  const magic = dv.getUint32(0, true);
  if (magic !== 0x46325034) return null;

  const salt = new Uint8Array(16);
  for (let j = 0; j < 16; j++) salt[j] = dv.getUint8(4 + j);

  const iter = dv.getUint32(20, true);

  const metaNonce = new Uint8Array(12);
  for (let j = 0; j < 12; j++) metaNonce[j] = dv.getUint8(24 + j);

  const encryptedBlock = pixelData.slice(INDEX_HEADER);

  return { salt, iter, metaNonce, encryptedBlock };
}

// ── 从解密后的元数据解析文件条目 ──

export function parseFileEntries(decryptedData) {
  const dv = new DataView(
    decryptedData.buffer,
    decryptedData.byteOffset,
    decryptedData.length,
  );
  const N = dv.getUint32(0, true); // N at offset 0
  if (N < 1 || N > 10000) return null;

  const entries = [];
  let off = META_HEADER; // N(4) + encMagic(4) + reserved(4) = 12

  for (let i = 0; i < N; i++) {
    const ifdOff = dv.getUint32(off, true);
    off += 4;
    const nl = dv.getUint16(off, true);
    off += 2;
    const nameBytes = new Uint8Array(nl);
    for (let j = 0; j < nl; j++) nameBytes[j] = dv.getUint8(off + j);
    off += nl;
    const fileSize = dv.getUint32(off, true);
    off += 4;
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
  return { entries, N };
}

// ── 容器解码（只解明文头，不解密）──

export async function decodeContainer(blob) {
  const info = await detectTiff(blob);
  if (!info) return null;

  const { le, ifd0Off } = info;
  const ifd0 = await readIFD(blob, ifd0Off, le);
  const tags = ifd0.tags;

  const sOff = getTagVal(tags, T_STRIP_OFFSETS);
  const sSize = getTagVal(tags, T_STRIP_BYTE_COUNTS);
  if (sOff === null || sSize === null || sSize > 10 * 1024 * 1024) return null;

  const pixelData = await readExternal(blob, sOff, sSize);
  const header = parseIndexHeader(pixelData);
  if (!header) return null;

  return {
    ...header,
    isF2P4: true,
    stripSize: sSize,
  };
}

// ── 密码验证 + 条目补齐（高层解码入口）──

/**
 * 解码 F2P4 TIFF 容器，含密码校验
 * @param {File} file - TIFF 文件
 * @param {string} password - 密码
 * @returns {{ entries: Array, key: CryptoKey }}
 * @throws 密码错误/格式损坏
 */
export async function decodeTiff(file, password) {
  const tiff = await decodeContainer(file);
  if (!tiff) throw Error("无法解析 TIFF 容器");

  const key = await deriveEncKey(password, tiff.salt, tiff.iter, true);
  const fullDec = await aesDecrypt(tiff.encryptedBlock, key, tiff.metaNonce, 0);

  // 校验密码：metaNonce 解密后直接验证 magic
  if (
    fullDec[4] !== 0x46 ||
    fullDec[5] !== 0x32 ||
    fullDec[6] !== 0x50 ||
    fullDec[7] !== 0x34
  )
    throw Error("密码错误");

  const parsed = parseFileEntries(fullDec);
  if (!parsed) throw Error("数据结构损坏");

  // 补齐 strip 偏移（从各自 IFD 读取）
  const le = tiff.endian || 0x49;
  for (const e of parsed.entries) {
    const fIfd = await readIFD(file, e.ifdOffset, le);
    const ft = fIfd.tags;
    const getVal = (tag) => {
      const t = ft.get(tag);
      if (!t || !t.inline) return 0;
      return new DataView(
        t.data.buffer,
        t.data.byteOffset,
        t.data.length,
      ).getUint32(0, true);
    };
    e.stripOffset = getVal(273);
    e.stripSize = getVal(279);
  }

  const entries = parsed.entries.map((e) => ({
    name: e.name,
    size: e.size,
    nonceData: e.nonce,
    offset: e.stripOffset,
    ctrStart: 0,
    _tiff: true,
  }));

  return { entries, key };
}
