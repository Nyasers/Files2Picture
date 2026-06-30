// ═══════════════════════════════════════════════
// F2P4 编码器（32-bit BMP，BGRA 原生顺序）
// ═══════════════════════════════════════════════

import { buildBMPStream, aesEncrypt } from "./f2p-core.js";

/**
 * 预计算 F2P4 BMP 尺寸
 * @param {{name:string,size:number}[]} files
 * @returns {{ ms:number, ds:number, ps:number, sz:number, fs:number }}
 */
export function precomputeBmp(files) {
  let ms = 32,
    ds = 0; // 32 = magic(4) + fileCount(4) + salt(16) + iter(4) + encMagic(4)
  for (const f of files) {
    const nl = new TextEncoder().encode(f.name).length;
    ms += 2 + nl + 8 + 12 + 12; // nameLen + name + size + nameNonce + dataNonce
    ds += f.size;
  }
  const ps = 8 + ms + ds;
  const sz = Math.max(4, Math.ceil(Math.sqrt(Math.ceil(ps / 4))));
  const fs = 54 + sz * sz * 4;
  return { ms, ds, ps, sz, fs };
}

/**
 * 创建 F2P4 BMP 写入器，返回 bmp 流对象
 * @param {object} layout - precomputeBmp 返回值
 * @param {(row:Uint8Array)=>void} onRow - 行推回调
 * @returns {object} bmp 流对象
 */
export function createBmpWriter(layout, onRow) {
  return buildBMPStream(layout.ms + layout.ds, onRow);
}

/**
 * 写入 F2P4 元数据头（含加密 magic 和文件条目）
 * @param {object} bmp - buildBMPStream 返回的流对象
 * @param {Uint8Array} salt - 16B
 * @param {CryptoKey} encKey
 * @param {{name:string,size:number}[]} files
 * @param {Uint8Array[]} fileNonces - 每文件 12B
 * @param {boolean} nameEnc
 */
export async function writeF2P4Header(bmp, salt, encKey, files, fileNonces) {
  bmp.w32(0x46325034); // F2P4 magic
  bmp.w32(files.length);
  bmp.wChunk(salt);
  bmp.w32(10000); // PBKDF2 迭代

  // 加密 magic 用于密码校验
  const magicEnc = await aesEncrypt(
    new Uint8Array([0x46, 0x32, 0x50, 0x34]),
    encKey,
    salt.subarray(0, 12),
    0,
  );
  bmp.wChunk(magicEnc);

  for (let i = 0; i < files.length; i++) {
    const nb = new TextEncoder().encode(files[i].name);
    const nd = fileNonces[i];
    const nn = crypto.getRandomValues(new Uint8Array(12));
    const en = await aesEncrypt(nb, encKey, nn, 0);
    bmp.w16(nb.length);
    bmp.wChunk(en);
    bmp.w64(files[i].size);
    bmp.wChunk(nn);
    bmp.wChunk(nd);
  }
}
