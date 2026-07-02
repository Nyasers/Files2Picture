// ═══════════════════════════════════════════════
// F2P2 解码器（加密，24-bit，通道映射 [2,1,0]）
// ═══════════════════════════════════════════════
"use strict";

import {
  readPayload,
  extendBuffer,
  deriveEncKey,
  aesDecrypt,
} from "../f2p-core.js";

export async function decodeF2P2(file, m, password) {
  const chMap = [2, 1, 0];
  const hdr = await readPayload(m, 4, 4, chMap);
  const fc = (hdr[0] << 24) | (hdr[1] << 16) | (hdr[2] << 8) | hdr[3];
  const fl = (await readPayload(m, 8, 1, chMap))[0];
  const salt = await readPayload(m, 9, 16, chMap);
  const itb = await readPayload(m, 25, 4, chMap);
  const iter = (itb[0] << 24) | (itb[1] << 16) | (itb[2] << 8) | itb[3];

  const key = await deriveEncKey(password, salt, iter, true);
  const me = await readPayload(m, 29, 4, chMap);
  const md = await aesDecrypt(me, key, salt.subarray(0, 12), 0, 32);
  if (md[0] !== 0x46 || md[1] !== 0x32 || md[2] !== 0x50 || md[3] !== 0x32)
    throw Error("密码错误");

  // ── 元数据条目解析（F2P2：24-bit 通道映射，可选的加密文件名，8B 大小，12B nonces）──
  const MS = 33;
  const encNameEnc = fl & 1;
  const entryMin = encNameEnc ? 2 + 8 + 12 + 12 : 2 + 8 + 12;
  let buf = await readPayload(m, MS, 65536, chMap);
  let off = 0;
  const entries = [];

  for (let i = 0; i < fc; i++) {
    while (off + entryMin > buf.length) {
      const more = await readPayload(m, MS + buf.length, 65536, chMap);
      buf = await extendBuffer(buf, more);
    }
    const nl = (buf[off] << 8) | buf[off + 1];
    off += 2;
    while (off + nl + (encNameEnc ? 8 + 12 + 12 : 8 + 12) > buf.length) {
      const more = await readPayload(m, MS + buf.length, 65536, chMap);
      buf = await extendBuffer(buf, more);
    }
    let nm, nonceData, size;
    if (encNameEnc) {
      const encName = buf.subarray(off, off + nl);
      off += nl;
      const hi =
        (buf[off] << 24) |
        (buf[off + 1] << 16) |
        (buf[off + 2] << 8) |
        buf[off + 3];
      const lo =
        (buf[off + 4] << 24) |
        (buf[off + 5] << 16) |
        (buf[off + 6] << 8) |
        buf[off + 7];
      size = hi * 0x100000000 + (lo >>> 0);
      off += 8;
      const nameNonce = buf.subarray(off, off + 12);
      off += 12;
      nonceData = buf.subarray(off, off + 12);
      off += 12;
      const ctr = new Uint8Array(16);
      ctr.set(nameNonce, 0);
      const decName = await crypto.subtle.decrypt(
        { name: "AES-CTR", counter: ctr, length: 32 },
        key,
        encName,
      );
      nm = new TextDecoder().decode(new Uint8Array(decName));
    } else {
      nm = new TextDecoder().decode(buf.subarray(off, off + nl));
      off += nl;
      const hi =
        (buf[off] << 24) |
        (buf[off + 1] << 16) |
        (buf[off + 2] << 8) |
        buf[off + 3];
      const lo =
        (buf[off + 4] << 24) |
        (buf[off + 5] << 16) |
        (buf[off + 6] << 8) |
        buf[off + 7];
      size = hi * 0x100000000 + (lo >>> 0);
      off += 8;
      nonceData = buf.subarray(off, off + 12);
      off += 12;
    }
    entries.push({ name: nm, size, nonceData: new Uint8Array(nonceData) });
  }

  let accOff = MS + off;
  for (const e of entries) {
    e.offset = accOff;
    accOff += e.size;
  }

  return { entries, key, meta: m, dataStart: MS + off };
}
