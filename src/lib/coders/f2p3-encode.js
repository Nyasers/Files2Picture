// ═══════════════════════════════════════════════
// F2P3 编码器（加密，32-bit，通道映射 [2,1,0,3]）
// ═══════════════════════════════════════════════

import { buildBMPStream, aesEncrypt } from "../f2p-core.js";

/**
 * 预计算 F2P3 BMP 尺寸
 * @param {{name:string,size:number}[]} files
 * @param {boolean} nameEnc - 是否加密文件名
 * @returns {{ ms:number, ds:number, ps:number, sz:number, fs:number }}
 */
export function precomputeBmp(files, nameEnc) {
  let ms = 33, // magic(4) + fileCount(4) + flags(1) + salt(16) + iter(4) + encMagic(4)
    ds = 0;
  for (const f of files) {
    const nl = new TextEncoder().encode(f.name).length;
    ms += 2 + nl + 8 + (nameEnc ? 12 : 0) + 12; // nameLen + name + size + [nameNonce] + dataNonce
    ds += f.size;
  }
  const ps = 8 + ms + ds;
  const k = Math.max(1, Math.floor(Math.sqrt(Math.floor(ps / 4))));
  const fs = 54 + ps;
  return { ms, ds, ps, sz: k, fs };
}

export function createBmpWriter(layout, onRow) {
  return buildBMPStream(layout.ms + layout.ds, onRow);
}

/**
 * 写入 F2P3 元数据头
 * @param {object} bmp
 * @param {Uint8Array} salt - 16B
 * @param {CryptoKey} encKey
 * @param {{name:string,size:number}[]} files
 * @param {Uint8Array[]} fileNonces - 每文件 dataNonce(12B)
 * @param {boolean} nameEnc
 */
export async function writeF2P3Header(
  bmp,
  salt,
  encKey,
  files,
  fileNonces,
  nameEnc,
) {
  bmp.w32(0x46325033); // F2P3 magic
  bmp.w32(files.length);
  bmp.w8(nameEnc ? 1 : 0); // flags
  bmp.wChunk(salt);
  bmp.w32(10000);

  const magicEnc = await aesEncrypt(
    new Uint8Array([0x46, 0x32, 0x50, 0x33]),
    encKey,
    salt.subarray(0, 12),
    0,
    32,
  );
  bmp.wChunk(magicEnc);

  for (let i = 0; i < files.length; i++) {
    const nb = new TextEncoder().encode(files[i].name);
    const nd = fileNonces[i];
    bmp.w16(nb.length);

    if (nameEnc) {
      const nn = crypto.getRandomValues(new Uint8Array(12));
      const en = await aesEncrypt(nb, encKey, nn, 0, 32);
      bmp.wChunk(en);
      bmp.w64(files[i].size);
      bmp.wChunk(nn);
      bmp.wChunk(nd);
    } else {
      bmp.wChunk(nb);
      bmp.w64(files[i].size);
      bmp.wChunk(nd);
    }
  }
}
