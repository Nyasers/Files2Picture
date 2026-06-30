// ═══════════════════════════════════════════════
// F2P 解码入口 — 自动识别版本并派发
// ═══════════════════════════════════════════════

import { readBmpHeader, readPayload } from "./f2p-core.js";
import { decodeF2P1 } from "./f2p1-decode.js";
import { decodeF2P2 } from "./f2p2-decode.js";
import { decodeF2P3 } from "./f2p3-decode.js";
import { decodeF2P4 } from "./f2p4-decode.js";

const F2P1 = 0x46325031;
const F2P2 = 0x46325032;
const F2P3 = 0x46325033;
const F2P4 = 0x46325034;

// ── 快速检测 ──

export async function quickDetect(file) {
  try {
    const m = await readBmpHeader(file);
    // 先试 BGRA 原生（F2P4）
    let hdr = await readPayload(m, 0, 4);
    let marker = (hdr[0] << 24) | (hdr[1] << 16) | (hdr[2] << 8) | hdr[3];
    const names = {
      [F2P1]: "F2P1",
      [F2P2]: "F2P2",
      [F2P3]: "F2P3",
      [F2P4]: "F2P4",
    };
    if (names[marker]) return "BMP · " + m.bpp + "-bit · " + names[marker];

    // 再试旧通道映射（F2P2/F2P3/F2P1）
    const chMap = m.bpp === 32 ? [2, 1, 0, 3] : [2, 1, 0];
    hdr = await readPayload(m, 0, 4, chMap);
    marker = (hdr[0] << 24) | (hdr[1] << 16) | (hdr[2] << 8) | hdr[3];
    if (names[marker]) return "BMP · " + m.bpp + "-bit · " + names[marker];

    return null;
  } catch {
    return null;
  }
}

// ── 统一解码入口 ──

export async function decodeContainer(file, password) {
  const m = await readBmpHeader(file);

  // 先试 BGRA 原生（F2P4）
  let hdr = await readPayload(m, 0, 4);
  let marker = (hdr[0] << 24) | (hdr[1] << 16) | (hdr[2] << 8) | hdr[3];
  if (marker === F2P4) return decodeF2P4(file, m, password);

  // 再试旧通道映射
  const chMap = m.bpp === 32 ? [2, 1, 0, 3] : [2, 1, 0];
  hdr = await readPayload(m, 0, 4, chMap);
  marker = (hdr[0] << 24) | (hdr[1] << 16) | (hdr[2] << 8) | hdr[3];

  switch (marker) {
    case F2P1:
      return decodeF2P1(file, m);
    case F2P2:
      return decodeF2P2(file, m, password);
    case F2P3:
      return decodeF2P3(file, m, password);
    default:
      throw Error("不支持的 BMP 格式或非 F2P 图片");
  }
}
