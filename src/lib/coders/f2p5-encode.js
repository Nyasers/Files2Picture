// ═══════════════════════════════════════════════
// F2P5 编码器（32-bit BMP，128-bit 完整 counter）
// ═══════════════════════════════════════════════

import { buildBMPStream, aesEncrypt } from "../f2p-core.js";

/**
 * 预计算 F2P5 BMP 尺寸
 * @param {{name:string,size:number}[]} files
 * @returns {{ ms:number, ds:number, ps:number, sz:number, fs:number }}
 */
export function precomputeBmp(files) {
  let ms = 32,
    ds = 0; // 32 = magic(4) + fileCount(4) + salt(16) + iter(4) + encMagic(4)
  for (const f of files) {
    const nl = new TextEncoder().encode(f.name).length;
    ms += 2 + nl + 8 + 16 + 16; // nameLen + name + size + nameCounter(16) + dataCounter(16)
    ds += f.size;
  }
  const ps = 8 + ms + ds;
  const k = Math.max(1, Math.floor(Math.sqrt(Math.floor(ps / 4))));
  const fs = 54 + ps;
  return { ms, ds, ps, sz: k, fs };
}

/**
 * 创建 F2P5 BMP 写入器
 * @param {object} layout - precomputeBmp 返回值
 * @param {(row:Uint8Array)=>void} onRow
 * @returns {object} bmp 流对象
 */
export function createBmpWriter(layout, onRow) {
  return buildBMPStream(layout.ms + layout.ds, onRow);
}

/**
 * 写入 F2P5 元数据头
 * @param {object} bmp - buildBMPStream 返回的流对象
 * @param {Uint8Array} salt - 16B
 * @param {CryptoKey} encKey
 * @param {{name:string,size:number}[]} files
 * @param {{name:Uint8Array, data:Uint8Array}[]} fileCounters - 每文件 16B + 16B
 */
export async function writeF2P5Header(bmp, salt, encKey, files, fileCounters) {
  bmp.w32(0x46325035); // F2P5 magic
  bmp.w32(files.length);
  bmp.wChunk(salt);
  bmp.w32(10000); // PBKDF2 迭代

  // 加密 magic 用于密码校验（用 16B zero-counter）
  const zeroCtr = new Uint8Array(16);
  const magicEnc = await aesEncrypt(
    new Uint8Array([0x46, 0x32, 0x50, 0x35]),
    encKey,
    zeroCtr,
    0,
    128,
  );
  bmp.wChunk(magicEnc);

  for (let i = 0; i < files.length; i++) {
    const nb = new TextEncoder().encode(files[i].name);
    const nc = fileCounters[i].name; // 16B
    const dc = fileCounters[i].data; // 16B
    const en = await aesEncrypt(nb, encKey, nc, 0, 128);
    bmp.w16(nb.length);
    bmp.wChunk(en);
    bmp.w64(files[i].size);
    bmp.wChunk(nc);
    bmp.wChunk(dc);
  }
}
