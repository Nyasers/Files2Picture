// ═══════════════════════════════════════════════
// F2P5 编码器（32-bit BMP，128-bit 完整 counter）
// ═══════════════════════════════════════════════
//
// ── 二进制布局（当前版本，编码入口和格式定义的唯一位置）──
//
//  BMP 头 (54 B)  →  元数据区  →  文件数据区  →  尾部
//                     (可跨像素区 & 尾部)
//                     像素区 k² 个 BGRA 像素，尾部分为 BMP 额外数据
//
//  偏移        大小      说明
//  ────────────────────────────────────────────────
//   0            4       F2P5 magic: 0x46325035
//   4            4       文件数量 (fileCount)
//   8           16       PBKDF2 salt
//  24            4       PBKDF2 迭代次数 (固定 10000)
//  28            4       encMagic: AES-CTR("F2P5", key, zeroCtr, 0, 128)
//  32            ?       文件条目列表 (重复 fileCount 次):
//                           2B  nameLen
//                           ?B  加密文件名 (AES-CTR, nameCounter, 0, 128)
//                           8B  文件大小 (big-endian uint64)
//                          16B  nameCounter
//                          16B  dataCounter
//  ────────────────────────────────────────────────
//  之后：文件数据区，各文件按顺序、每文件用独立 dataCounter 加密
//        数据使用 AES-CTR length=128（全 counter，永不溢出）
//
//  像素区取最大完全平方数 k² 个像素 (k²×4 <= payload)，
//  尾部以 BMP 额外数据存放。bfSize = 54 + 4k²，实际文件 = 54 + payload
// ═══════════════════════════════════════════════
"use strict";

import {
  buildBMPStream,
  aesEncrypt,
  deriveEncKey,
  aesDecrypt,
  F2P5,
} from "../f2p-core.js";

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
  bmp.w32(F2P5); // F2P5 magic
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
