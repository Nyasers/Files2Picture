// ═══════════════════════════════════════════════
// F2P4 解码器（加密，32-bit，BGRA 原生顺序）
// ═══════════════════════════════════════════════

import {
  readPayload,
  decMetaStream,
  deriveEncKey,
  aesDecrypt,
} from "./f2p-core.js";

export async function decodeF2P4(file, m, password) {
  const hdr = await readPayload(m, 4, 4);
  const fc = (hdr[0] << 24) | (hdr[1] << 16) | (hdr[2] << 8) | hdr[3];
  const salt = await readPayload(m, 8, 16);
  const itb = await readPayload(m, 24, 4);
  const iter = (itb[0] << 24) | (itb[1] << 16) | (itb[2] << 8) | itb[3];

  const key = await deriveEncKey(password, salt, iter, true);
  const me = await readPayload(m, 28, 4);
  const md = await aesDecrypt(me, key, salt.subarray(0, 12), 0);
  if (md[0] !== 0x46 || md[1] !== 0x32 || md[2] !== 0x50 || md[3] !== 0x34)
    throw Error("密码错误");

  const r = await decMetaStream(m, fc, 1, key, 32);
  return { entries: r.ent, key, meta: m, dataStart: r.ds };
}
