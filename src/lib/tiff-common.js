// ═══════════════════════════════════════════════
// 标准 TIFF 公共模块（魔数 42，单页 IFD + 尾巴载荷）
// 看图软件只看到 IFD#0 的索引页，文件数据紧跟在后面
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
export const typeSize = { 3: 2, 4: 4 };

// ── 索引表格式 ──
// Magic(4) + salt(16) + iter(4) + metaNonce(12) = 36 明文头
// 其后全部加密: N(4) + encMagic(4) + reserved(4) + per-file[...]
export const INDEX_HEADER = 36;
export const META_HEADER = 12; // N(4) + encMagic(4) + reserved(4)
// 每个文件条目: dataOffset(8) + nameLen(2) + name(nl) + fileSize(4) + nonce(12)
export function indexEntrySize(nl) {
  return 8 + 2 + nl + 4 + 12; // = 26 + nl
}

// ── IFD 常量 ──
// IFD: entryCount(2B) + entries(12B) + nextIFD(4B)
// 标准 tag 共 10 个：W, H, BPS, Comp, Photo, Extra, SOff, SPP, RPS, SBC
export const STD_N = 10;
export const STD_HDR = 2 + STD_N * IFD_ENTRY + 4; // = 126
// 外部：BPS[8,8,8,8] = 8B
export const STD_EXT = 8;

// ── 工具 ──
export function w16(dv, o, v) {
  dv.setUint16(o, v, true);
}
export function w32(dv, o, v) {
  dv.setUint32(o, v, true);
}
export function w64(dv, o, v) {
  dv.setBigUint64(o, BigInt(v), true);
}
export function we(dv, o, tag, type, cnt, val) {
  w16(dv, o, tag);
  w16(dv, o + 2, type);
  w32(dv, o + 4, cnt);
  w32(dv, o + 8, val);
}

// ── precomputeLayout ──

/**
 * 布局：只有一页 IFD#0（索引页），文件数据直接拼接在尾巴上。
 * 索引条目存 64-bit dataOffset，支持 >4GB。
 */
export function precomputeLayout(files) {
  const N = files.length;
  const enc = new TextEncoder();
  const NL = files.map((f) => enc.encode(f.name).length);
  const fileSizes = files.map((f) => f.size);

  // 索引表大小（含明文头 + META_HEADER + 文件条目）
  const indexSize =
    N > 0
      ? INDEX_HEADER +
        META_HEADER +
        files.reduce((s, _, i) => s + indexEntrySize(NL[i]), 0)
      : INDEX_HEADER + META_HEADER;
  // IFD#0 像素尺寸：至少 4x4，让看图软件能看到东西
  const idxSide = Math.max(4, Math.ceil(Math.sqrt(Math.ceil(indexSize / 4))));
  const idxStripSize = idxSide * idxSide * 4;

  const H = TIFF_HDR_SIZE;
  const ifdTotal = STD_HDR + STD_EXT; // IFD#0 块大小（含外部 BPS）
  const strip0Off = H + ifdTotal; // 索引页 strip 偏移

  // 文件数据从索引页后开始
  let cursor = strip0Off + idxStripSize;
  const dataOffsets = [];
  for (let i = 0; i < N; i++) {
    dataOffsets.push(cursor);
    cursor += fileSizes[i]; // 直接拼接，无 padding
  }

  return {
    N,
    NL,
    fileSizes,
    dataOffsets,
    indexSize,
    idxSide,
    idxStripSize,
    ifdTotal,
    H,
    totalSize: cursor,
  };
}
