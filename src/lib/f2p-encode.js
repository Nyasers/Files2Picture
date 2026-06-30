// ═══════════════════════════════════════════════
// F2P 编码外观 — 统一编码入口
// ═══════════════════════════════════════════════

import { deriveEncKey, aesEncrypt } from "./f2p-core.js";
import { precomputeLayout } from "./tiff-common.js";
import { buildHeader, buildIFD, buildIndexPixels } from "./tiff-encode.js";

/**
 * 编码为 TIFF（单页 IFD + 尾巴载荷）
 * @param {File[]} files - 待编码的文件
 * @param {string} password - 密码
 * @param {object} options
 * @param {number} [options.chunkSize=64] - KB
 * @returns {Promise<{header:Uint8Array, ifd0:Uint8Array, indexPixels:Uint8Array,
 *   fileData:Uint8Array[],
 *   layout:object, encKey:CryptoKey, salt:Uint8Array}>}
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
    layout.H, // ifd0 偏移 (8)
    0, // nextIFD = 0，没有后续页
    layout.idxSide,
    layout.idxSide,
    layout.H + layout.ifdTotal, // 索引页 strip 偏移
    layout.idxStripSize,
  );

  // 逐文件加密，直接拼接
  const fileData = [];
  const ck = chunkSize * 1024;

  for (let i = 0; i < layout.N; i++) {
    const f = files[i];
    const nd = payloadNonces.subarray(i * 12, (i + 1) * 12);

    const parts = [];
    let pos = 0;
    while (pos < f.size) {
      const end = Math.min(pos + ck, f.size);
      const buf = new Uint8Array(await f.slice(pos, end).arrayBuffer());
      const enc = await aesEncrypt(buf, encKey, nd, pos / 16);
      parts.push(enc);
      pos = end;
    }
    fileData.push(parts);
  }

  return {
    header,
    ifd0,
    indexPixels,
    fileData,
    layout,
    encKey,
    salt,
    payloadNonces,
  };
}
