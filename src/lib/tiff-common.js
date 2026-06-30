// ═══════════════════════════════════════════════
// 标准 TIFF 公共模块（魔数 42，多页 IFD，零私有 tag）
// ═══════════════════════════════════════════════

export const TIFF_HDR_SIZE = 8;
export const IFD_ENTRY = 12;

// ── 标准 tag ──
export const T_IMAGE_WIDTH = 256;
export const T_IMAGE_LENGTH = 257;
export const T_BITS_PER_SAMPLE = 258;
export const T_COMPRESSION = 259;
export const T_PHOTO_INTERP = 262;
export const T_STRIP_OFFSETS = 273;
export const T_SAMPLES_PER_PIXEL = 277;
export const T_ROWS_PER_STRIP = 278;
export const T_STRIP_BYTE_COUNTS = 279;
export const T_EXTRA_SAMPLES = 338;

// ── 类型 ──
export const TYP_SHORT = 3;
export const TYP_LONG = 4;
export const typeSize = { 3:2, 4:4 };

// ── 索引表格式 ──
// Magic(4) + reserved(4) + N(4) + salt(16) + iter(4) + magic_check(4) = 36
// + per-file[IFDoff(4)+nameLen(2)+name(NL)+size(4)+nonce(12)]
export const INDEX_HEADER = 36;
export function indexEntrySize(nl) { return 4 + 2 + nl + 4 + 12; }

// ── IFD 常量 ──
// IFD: entryCount(2B) + entries(12B) + nextIFD(4B)
// 标准 tag 共 10 个：W, H, BPS, Comp, Photo, Extra, SOff, SPP, RPS, SBC
export const STD_N = 10;
export const STD_HDR = 2 + STD_N * IFD_ENTRY + 4; // = 126
// 外部：BPS[8,8,8,8] = 8B
export const STD_EXT = 8;

// ── 工具 ──
export function w16(dv, o, v) { dv.setUint16(o, v, true); }
export function w32(dv, o, v) { dv.setUint32(o, v, true); }
export function we(dv, o, tag, type, cnt, val) {
  w16(dv, o, tag); w16(dv, o+2, type);
  w32(dv, o+4, cnt); w32(dv, o+8, val);
}

// ── precomputeLayout ──

export function precomputeLayout(files) {
  const N = files.length;
  const enc = new TextEncoder();
  const NL = files.map(f => enc.encode(f.name).length);
  const fileSizes = files.map(f => f.size);

  // 数据页像素尺寸
  const S = files.map(f => {
    const side = Math.max(1, Math.ceil(Math.sqrt(Math.ceil(f.size / 4))));
    return side * side * 4;
  });

  // 索引表大小
  const indexSize = N > 0
    ? INDEX_HEADER + files.reduce((s, _, i) => s + indexEntrySize(NL[i]), 0)
    : INDEX_HEADER;
  const idxSide = Math.max(4, Math.ceil(Math.sqrt(Math.ceil(indexSize / 4))));
  const idxStripSize = idxSide * idxSide * 4;

  const H = TIFF_HDR_SIZE;
  const ifdTotal = STD_HDR + STD_EXT; // 每个 IFD 块大小（含外部 BPS）

  // IFD#0
  const ifd0Off = H;
  const strip0Off = ifd0Off + ifdTotal;
  let cursor = strip0Off + idxStripSize;

  const ifdOffsets = [ifd0Off];
  const stripOffsets = [strip0Off];

  for (let i = 0; i < N; i++) {
    ifdOffsets.push(cursor);
    cursor += ifdTotal; // IFD header + BPS
    stripOffsets.push(cursor);
    cursor += S[i]; // encrypted payload
  }

  return { N, NL, fileSizes, S, indexSize, idxSide, idxStripSize,
    ifdTotal, H, ifdOffsets, stripOffsets, totalSize: cursor };
}