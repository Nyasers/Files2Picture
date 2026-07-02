// ═══════════════════════════════════════════════
// F2P4 解码器（加密，32-bit，BGRA 原生顺序）
// ═══════════════════════════════════════════════
"use strict";

import {
  readPayload,
  extendBuffer,
  deriveEncKey,
  aesDecrypt,
} from "../f2p-core.js";

export async function decodeF2P4(file, m, password) {
  const hdr = await readPayload(m, 4, 4);
  const fc = (hdr[0] << 24) | (hdr[1] << 16) | (hdr[2] << 8) | hdr[3];
  const salt = await readPayload(m, 8, 16);
  const itb = await readPayload(m, 24, 4);
  const iter = (itb[0] << 24) | (itb[1] << 16) | (itb[2] << 8) | itb[3];

  const key = await deriveEncKey(password, salt, iter, true);
  const me = await readPayload(m, 28, 4);
  const md = await aesDecrypt(me, key, salt.subarray(0, 12), 0, 32);
  if (md[0] !== 0x46 || md[1] !== 0x32 || md[2] !== 0x50 || md[3] !== 0x34)
    throw Error("密码错误");

  // ── 元数据条目解析（F2P4：加密文件名，8B 大小，12B nonces）──
  const MS = 32;
  let buf = await readPayload(m, MS, 65536);
  let off = 0;
  const entries = [];

  for (let i = 0; i < fc; i++) {
    while (off + 34 > buf.length) {
      const more = await readPayload(m, MS + buf.length, 65536);
      buf = await extendBuffer(buf, more);
    }
    const nl = (buf[off] << 8) | buf[off + 1];
    off += 2;
    while (off + nl + 8 + 12 + 12 > buf.length) {
      const more = await readPayload(m, MS + buf.length, 65536);
      buf = await extendBuffer(buf, more);
    }
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
    const size = hi * 0x100000000 + (lo >>> 0);
    off += 8;
    const nameNonce = buf.subarray(off, off + 12);
    off += 12;
    const dataNonce = buf.subarray(off, off + 12);
    off += 12;
    const ctr = new Uint8Array(16);
    ctr.set(nameNonce, 0);
    const decName = await crypto.subtle.decrypt(
      { name: "AES-CTR", counter: ctr, length: 32 },
      key,
      encName,
    );
    const _ctr = new Uint8Array(16);
    _ctr.set(new Uint8Array(dataNonce), 0);
    entries.push({
      name: new TextDecoder().decode(new Uint8Array(decName)),
      size,
      nonceData: new Uint8Array(dataNonce),
      counter: _ctr,
      bits: 32,
    });
  }

  let accOff = MS + off;
  for (const e of entries) {
    e.offset = accOff;
    accOff += e.size;
  }

  return { entries, key, meta: m, dataStart: MS + off };
}
