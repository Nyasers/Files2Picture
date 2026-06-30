// ═══════════════════════════════════════════════
// F2P 编码外观 — 统一编码入口
// ═══════════════════════════════════════════════

import { deriveEncKey, aesEncrypt } from "./f2p-core.js";
import { precomputeLayout } from "./tiff-common.js";
import { buildHeader, buildIFD, buildIndexPixels } from "./tiff-encode.js";

/**
 * 编码为 TIFF（当前唯一输出格式）
 * @param {File[]} files - 待编码的文件
 * @param {string} password - 密码
 * @param {object} options
 * @param {number} [options.chunkSize=64] - KB
 * @param {boolean} [options.nameEnc] - 是否加密文件名（预留）
 * @returns {Promise<{header:Uint8Array, ifd0:Uint8Array, indexPixels:Uint8Array,
 *   fileChunks:{ifd:Uint8Array, data:Uint8Array}[],
 *   layout:object, encKey:CryptoKey, salt:Uint8Array}>}
 *
 * 返回分段数据，调用方自行组装或流式推送。
 */
export async function encodeTiff(files, password, options = {}) {
  const { chunkSize = 64 } = options;

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const encKey = await deriveEncKey(password, salt, 10000);

  const layout = precomputeLayout(
    files.map((f) => ({ name: f.name, size: f.size })),
  );

  const fileNames = files.map((f) => f.name);
  const { pixels: indexPixels, payloadNonces } = await buildIndexPixels(
    layout,
    fileNames,
    salt,
    10000,
    new Uint8Array([0x46, 0x32, 0x50, 0x34]),
    encKey,
  );

  const header = buildHeader(layout.H);
  const ifd0 = buildIFD(
    layout.ifdOffsets[0],
    layout.NG > 0 ? layout.ifdOffsets[1] : 0,
    layout.idxSide,
    layout.idxSide,
    layout.stripOffsets[0],
    layout.idxStripSize,
  );

  const fileChunks = [];
  const ck = chunkSize * 1024;

  for (let gi = 0; gi < layout.NG; gi++) {
    const g = layout.groups[gi];
    const nextOff = gi + 1 < layout.NG ? layout.ifdOffsets[gi + 2] : 0;
    const ifdBuf = buildIFD(
      layout.ifdOffsets[gi + 1],
      nextOff,
      g.side,
      g.side,
      layout.stripOffsets[gi + 1],
      g.stripSize,
    );

    // 组内所有文件依次加密
    const encDataParts = [];
    for (let fi = g.start; fi < g.end; fi++) {
      const f = files[fi];
      const nd = payloadNonces.subarray(fi * 12, (fi + 1) * 12);
      let pos = 0;
      while (pos < f.size) {
        const end = Math.min(pos + ck, f.size);
        const buf = new Uint8Array(await f.slice(pos, end).arrayBuffer());
        const enc = await aesEncrypt(buf, encKey, nd, pos / 16);
        encDataParts.push(enc);
        pos = end;
      }
    }
    // 填充至 strip 对齐
    const encTotal = encDataParts.reduce((s, p) => s + p.length, 0);
    const padding = g.stripSize - encTotal;
    if (padding > 0) encDataParts.push(new Uint8Array(padding));

    fileChunks.push({
      ifd: ifdBuf,
      data: encDataParts,
    });
  }

  return {
    header,
    ifd0,
    indexPixels,
    fileChunks,
    layout,
    encKey,
    salt,
    payloadNonces,
  };
}
