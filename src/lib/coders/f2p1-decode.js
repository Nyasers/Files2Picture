// ═══════════════════════════════════════════════
// F2P1 解码器（无加密，24-bit）
// ═══════════════════════════════════════════════
"use strict";

import { readPayload, extendBuffer } from "../f2p-core.js";

export async function decodeF2P1(file, m) {
  const chMap = [2, 1, 0];
  const hdr = await readPayload(m, 4, 4, chMap);
  const fc = (hdr[0] << 24) | (hdr[1] << 16) | (hdr[2] << 8) | hdr[3];

  // ── 元数据条目解析（F2P1：无加密，4B 大小，无 nonces）──
  const MS = 8;
  let buf = await readPayload(m, MS, 65536, chMap);
  let off = 0;
  const entries = [];

  for (let i = 0; i < fc; i++) {
    while (off + 6 > buf.length) {
      const more = await readPayload(m, MS + buf.length, 65536, chMap);
      buf = await extendBuffer(buf, more);
    }
    const nl = (buf[off] << 8) | buf[off + 1];
    off += 2;
    while (off + nl + 4 > buf.length) {
      const more = await readPayload(m, MS + buf.length, 65536, chMap);
      buf = await extendBuffer(buf, more);
    }
    const name = new TextDecoder().decode(buf.subarray(off, off + nl));
    off += nl;
    const size =
      ((buf[off] << 24) |
        (buf[off + 1] << 16) |
        (buf[off + 2] << 8) |
        buf[off + 3]) >>>
      0;
    off += 4;
    entries.push({ name, size, nonceData: null, counter: null, bits: 0 });
  }

  let accOff = MS + off;
  for (const e of entries) {
    e.offset = accOff;
    accOff += e.size;
  }

  return { entries, key: null, meta: m, dataStart: MS + off };
}
