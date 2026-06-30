// ═══════════════════════════════════════════════
// 标准 TIFF 编码器（零私有 tag，多页 IFD）
// ═══════════════════════════════════════════════

import {
  TIFF_HDR_SIZE, IFD_ENTRY,
  STD_N, STD_HDR, STD_EXT,
  INDEX_HEADER, indexEntrySize,
  w16, w32, we,
  T_IMAGE_WIDTH, T_IMAGE_LENGTH, T_BITS_PER_SAMPLE,
  T_COMPRESSION, T_PHOTO_INTERP, T_STRIP_OFFSETS,
  T_SAMPLES_PER_PIXEL, T_ROWS_PER_STRIP, T_STRIP_BYTE_COUNTS,
  T_EXTRA_SAMPLES,
  TYP_SHORT, TYP_LONG,
} from "./tiff-common.js";

// ── 文件头 ──
export function buildHeader(ifd0Off) {
  const b = new ArrayBuffer(8);
  const v = new DataView(b);
  v.setUint8(0, 0x49); v.setUint8(1, 0x49);
  v.setUint8(2, 0x2a); v.setUint8(3, 0x00);
  w32(v, 4, ifd0Off);
  return new Uint8Array(b);
}

// ── 索引像素（IFD#0 的 strip 数据）──
export function buildIndexPixels(layout, fileNames, salt, iter, encMagic) {
  const { N, NL, fileSizes, ifdOffsets, idxStripSize } = layout;
  const px = new Uint8Array(idxStripSize);
  for (let i = 0; i < idxStripSize; i++) px[i] = 0x80;

  const allNonces = N > 0 ? crypto.getRandomValues(new Uint8Array(N * 12)) : new Uint8Array(0);

  const dv = new DataView(px.buffer, px.byteOffset, px.length);
  let off = 0;

  w32(dv, off, 0x46325034); off += 4; // magic "F2P4"
  w32(dv, off, 0); off += 4;           // reserved
  w32(dv, off, N); off += 4;           // file count
  for (let j = 0; j < 16; j++) dv.setUint8(off + j, salt[j]); off += 16; // salt
  w32(dv, off, iter); off += 4;        // iter
  for (let j = 0; j < 4; j++) dv.setUint8(off + j, encMagic[j]); off += 4; // magic_check

  for (let i = 0; i < N; i++) {
    w32(dv, off, ifdOffsets[i + 1]); off += 4; // IFD offset
    w16(dv, off, NL[i]); off += 2;             // name length
    const nb = new TextEncoder().encode(fileNames[i]);
    for (let j = 0; j < nb.length; j++) dv.setUint8(off + j, nb[j]);
    off += NL[i];
    w32(dv, off, fileSizes[i]); off += 4;       // file size
    for (let j = 0; j < 12; j++) dv.setUint8(off + j, allNonces[i * 12 + j]);
    off += 12;
  }

  // 索引表之后的像素画彩色块
  const colorStart = Math.ceil(layout.indexSize / 4);
  for (let i = 0; i < N; i++) {
    const [r, g, b] = hashColor(fileNames[i]);
    const pxIdx = colorStart + (i % layout.idxSide) + Math.floor(i / layout.idxSide) * layout.idxSide;
    const po = pxIdx * 4;
    if (po + 3 < idxStripSize) {
      px[po] = r; px[po+1] = g; px[po+2] = b; px[po+3] = 0xff;
    }
  }

  return { pixels: px, fileNonces: allNonces };
}

function hashColor(name) {
  const b = new TextEncoder().encode(name);
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193); }
  return [h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff];
}

// ── IFD 构建（通用，适用于所有页）──
// 所有 IFD 共用 10 个标准 tag，差别仅 W/H/SOff/SBC
export function buildIFD(ifdOffset, nextIfdOffset, w, h, stripOffset, stripSize) {
  const buf = new ArrayBuffer(STD_HDR + STD_EXT);
  const v = new DataView(buf);
  let o = 0;

  w16(v, o, STD_N); o += 2;

  we(v, o, T_IMAGE_WIDTH, TYP_SHORT, 1, w); o += IFD_ENTRY;
  we(v, o, T_IMAGE_LENGTH, TYP_SHORT, 1, h); o += IFD_ENTRY;
  const bpsOff = o;
  we(v, o, T_BITS_PER_SAMPLE, TYP_SHORT, 4, 0); o += IFD_ENTRY;
  we(v, o, T_COMPRESSION, TYP_SHORT, 1, 1); o += IFD_ENTRY;
  we(v, o, T_PHOTO_INTERP, TYP_SHORT, 1, 2); o += IFD_ENTRY;
  we(v, o, T_EXTRA_SAMPLES, TYP_SHORT, 1, 2); o += IFD_ENTRY;
  we(v, o, T_STRIP_OFFSETS, TYP_LONG, 1, stripOffset); o += IFD_ENTRY;
  we(v, o, T_SAMPLES_PER_PIXEL, TYP_SHORT, 1, 4); o += IFD_ENTRY;
  we(v, o, T_ROWS_PER_STRIP, TYP_LONG, 1, h); o += IFD_ENTRY;
  we(v, o, T_STRIP_BYTE_COUNTS, TYP_LONG, 1, stripSize); o += IFD_ENTRY;

  w32(v, o, nextIfdOffset); o += 4;

  // BPS external [8,8,8,8]
  for (let i = 0; i < 4; i++) { v.setUint8(o + i*2, 8); v.setUint8(o + i*2+1, 0); }
  w32(v, bpsOff + 8, ifdOffset + STD_HDR); // BPS ext offset (absolute)

  return new Uint8Array(buf);
}