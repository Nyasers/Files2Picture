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
export const typeSize = { 3: 2, 4: 4 };

// ── 索引表格式 ──
// Magic(4) + salt(16) + iter(4) + metaNonce(12) = 36 明文头
// 其后全部加密: N(4) + encMagic(4) + reserved(4) + per-file[...]
export const INDEX_HEADER = 36;
export const META_HEADER = 12; // N(4) + encMagic(4) + reserved(4)
// 每个文件条目: ifdOffset(4) + offsetInStrip(4) + nameLen(2) + name(nl) + fileSize(4) + nonce(12)
export function indexEntrySize(nl) {
  return 4 + 4 + 2 + nl + 4 + 12;
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
export function we(dv, o, tag, type, cnt, val) {
  w16(dv, o, tag);
  w16(dv, o + 2, type);
  w32(dv, o + 4, cnt);
  w32(dv, o + 8, val);
}

// ── precomputeLayout ──

/**
 * 最优分组：DP 最小化总 zero-padding
 * 对文件 [i, j) 分到同一页，padding = side²×4 − totalSize
 */
function optimalGroups(fileSizes) {
  const N = fileSizes.length;
  if (N === 0) return [];

  // prefix sum for O(1) range total
  const ps = [0];
  for (let i = 0; i < N; i++) ps.push(ps[i] + fileSizes[i]);

  function groupPadding(i, j) {
    const total = ps[j] - ps[i];
    const side = Math.max(1, Math.ceil(Math.sqrt(Math.ceil(total / 4))));
    return side * side * 4 - total;
  }

  // DP[i] = min padding for first i files
  const dp = [0];
  const split = [0]; // split[i] = start of last group for first i files
  for (let i = 1; i <= N; i++) {
    let best = Infinity,
      bestJ = 0;
    for (let j = 0; j < i; j++) {
      const val = dp[j] + groupPadding(j, i);
      if (val < best) {
        best = val;
        bestJ = j;
      }
    }
    dp.push(best);
    split.push(bestJ);
  }

  // Reconstruct groups
  const groups = [];
  let end = N;
  while (end > 0) {
    const start = split[end];
    groups.unshift({ start, end });
    end = start;
  }

  // Compute group properties
  for (const g of groups) {
    const total = ps[g.end] - ps[g.start];
    const side = Math.max(1, Math.ceil(Math.sqrt(Math.ceil(total / 4))));
    g.totalSize = total;
    g.side = side;
    g.stripSize = side * side * 4;
  }

  return groups;
}

export function precomputeLayout(files) {
  const N = files.length;
  const enc = new TextEncoder();
  const NL = files.map((f) => enc.encode(f.name).length);
  const fileSizes = files.map((f) => f.size);

  // ── 最优分组 ──
  const groups = optimalGroups(fileSizes);
  const NG = groups.length;

  // 每个文件所属组索引和组内偏移
  const fileGIdx = [];
  const fileOffsetInStrip = [];
  for (let gi = 0; gi < NG; gi++) {
    const g = groups[gi];
    let off = 0;
    for (let fi = g.start; fi < g.end; fi++) {
      fileGIdx[fi] = gi;
      fileOffsetInStrip[fi] = off;
      off += fileSizes[fi];
    }
  }

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
  const ifdTotal = STD_HDR + STD_EXT; // 每个 IFD 块大小（含外部 BPS）

  // IFD#0
  const ifd0Off = H;
  const strip0Off = ifd0Off + ifdTotal;
  let cursor = strip0Off + idxStripSize;

  const ifdOffsets = [ifd0Off];
  const stripOffsets = [strip0Off];

  for (let gi = 0; gi < NG; gi++) {
    ifdOffsets.push(cursor);
    cursor += ifdTotal;
    stripOffsets.push(cursor);
    cursor += groups[gi].stripSize;
  }

  return {
    N,
    NG,
    NL,
    fileSizes,
    groups,
    fileGIdx,
    fileOffsetInStrip,
    indexSize,
    idxSide,
    idxStripSize,
    ifdTotal,
    H,
    ifdOffsets,
    stripOffsets,
    totalSize: cursor,
  };
}
