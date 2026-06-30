// ═══════════════════════════════════════════════
// F2P3 解码器（加密，32-bit，通道映射 [2,1,0,3]）
// ═══════════════════════════════════════════════

import {
  readPayload,
  decMetaStream,
  deriveEncKey,
  aesDecrypt,
} from "./f2p-core.js";

export async function decodeF2P3(file, m, password) {
  const chMap = [2, 1, 0, 3];
  const hdr = await readPayload(m, 4, 4, chMap);
  const fc = (hdr[0] << 24) | (hdr[1] << 16) | (hdr[2] << 8) | hdr[3];
  const fl = (await readPayload(m, 8, 1, chMap))[0];
  const salt = await readPayload(m, 9, 16, chMap);
  const itb = await readPayload(m, 25, 4, chMap);
  const iter = (itb[0] << 24) | (itb[1] << 16) | (itb[2] << 8) | itb[3];

  const key = await deriveEncKey(password, salt, iter, true);
  const me = await readPayload(m, 29, 4, chMap);
  const md = await aesDecrypt(me, key, salt.subarray(0, 12), 0);
  if (md[0] !== 0x46 || md[1] !== 0x32 || md[2] !== 0x50 || md[3] !== 0x33)
    throw Error("密码错误");

  const r = await decMetaStream(m, fc, fl, key, 33, chMap);
  return { entries: r.ent, key, meta: m, dataStart: r.ds };
}
