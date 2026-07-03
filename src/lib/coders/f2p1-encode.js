// ═══════════════════════════════════════════════
// F2P1 编码器（无加密，24-bit，通道映射 [2,1,0]）
// ═══════════════════════════════════════════════

import { buildBMPStream, F2P1 } from "../f2p-core.js";

/**
 * 预计算 F2P1 BMP 尺寸
 * @param {{name:string,size:number}[]} files
 * @returns {{ ms:number, ds:number, ps:number, sz:number, fs:number }}
 */
export function precomputeBmp(files) {
  let ms = 8, // magic(4) + fileCount(4)
    ds = 0;
  for (const f of files) {
    const nl = new TextEncoder().encode(f.name).length;
    ms += 2 + nl + 4; // nameLen + name + size(32-bit)
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
 * 写入 F2P1 元数据头（无加密）
 */
export async function writeF2P1Header(bmp, files) {
  bmp.w32(F2P1); // F2P1 magic
  bmp.w32(files.length);

  for (const f of files) {
    const nb = new TextEncoder().encode(f.name);
    bmp.w16(nb.length);
    bmp.wChunk(nb);
    bmp.w32(f.size);
  }
}

/**
 * 写入文件数据（明文，无加密）
 */
export async function writeF2P1Data(bmp, file, onProgress) {
  const ck = 65536;
  let pos = 0;
  while (pos < file.size) {
    const end = Math.min(pos + ck, file.size);
    const buf = await file.slice(pos, end).arrayBuffer();
    bmp.wChunk(new Uint8Array(buf));
    pos = end;
    if (onProgress) onProgress(pos, file.size);
  }
}
