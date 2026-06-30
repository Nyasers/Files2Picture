// ═══════════════════════════════════════════════
// F2P1 解码器（无加密，24-bit）
// ═══════════════════════════════════════════════

import { readPayload, decMetaStream } from "./f2p-core.js";

export async function decodeF2P1(file, m) {
  const hdr = await readPayload(m, 4, 4, [2, 1, 0]);
  const fc = (hdr[0] << 24) | (hdr[1] << 16) | (hdr[2] << 8) | hdr[3];
  const r = await decMetaStream(m, fc, 0, null, 8, [2, 1, 0]);
  return { entries: r.ent, key: null, meta: m, dataStart: r.ds };
}
