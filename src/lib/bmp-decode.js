// ═══════════════════════════════════════════════
// BMP 解码器（F2P3 及更早）
// ═══════════════════════════════════════════════

import {
  fmt,
  readBmpHeader,
  readPayload,
  decMetaStream,
  deriveEncKey,
  aesDecrypt,
} from "./f2p-core.js";

/**
 * 快速检测 BMP 子格式
 * @param {File} file
 * @returns {Promise<string|null>} 如 "BMP · 32-bit · F2P3"
 */
export async function quickDetectBmp(file) {
  try {
    const m = await readBmpHeader(file);
    const bppLabel = m.bpp + "-bit";
    const hdr = await readPayload(m, 0, 8);
    const marker = (hdr[0] << 24) | (hdr[1] << 16) | (hdr[2] << 8) | hdr[3];
    let label = "未知格式";
    if (marker === 0x46325033) label = "F2P3";
    else if (marker === 0x46325032) label = "F2P2";
    else if (marker === 0x46325031) label = "F2P1";
    else if (((hdr[0] << 8) | hdr[1]) > 0) label = "旧格式";
    return "BMP · " + bppLabel + " · " + label;
  } catch {
    return null;
  }
}

/**
 * 解码 BMP 容器（F2P1 / F2P2 / F2P3）
 * @param {File} file - BMP 文件
 * @param {string} password - 密码（无密码传 ""）
 * @returns {{ entries: Array, key: CryptoKey|null, meta: object, dataStart: number }}
 * @throws 密码错误/格式损坏
 */
export async function decodeBmp(file, password) {
  const m = await readBmpHeader(file);
  const hdr = await readPayload(m, 0, 8);
  const marker = (hdr[0] << 24) | (hdr[1] << 16) | (hdr[2] << 8) | hdr[3];
  const isEnc = (marker & 0xffffff00) === 0x46325000 && (marker & 0xff) > 1;
  const isF2P1 = marker === 0x46325031;
  let ent, ds, key;

  if (isF2P1) {
    const fc = ((hdr[4] << 24) | (hdr[5] << 16) | (hdr[6] << 8) | hdr[7]) >>> 0;
    const r = await decMetaStream(m, fc, 0, null, 8);
    ent = r.ent;
    ds = r.ds;
    key = null;
  } else if (isEnc) {
    const fc = ((hdr[4] << 24) | (hdr[5] << 16) | (hdr[6] << 8) | hdr[7]) >>> 0;
    const fl = (await readPayload(m, 8, 1))[0];
    const salt = await readPayload(m, 9, 16);
    const itb = await readPayload(m, 25, 4);
    const iter = (itb[0] << 24) | (itb[1] << 16) | (itb[2] << 8) | itb[3];
    key = await deriveEncKey(password, salt, iter, true);
    const me = await readPayload(m, 29, 4);
    const md = await aesDecrypt(me, key, salt.subarray(0, 12), 0);
    if (
      md[0] !== ((marker >>> 24) & 255) ||
      md[1] !== ((marker >>> 16) & 255) ||
      md[2] !== ((marker >>> 8) & 255) ||
      md[3] !== (marker & 255)
    )
      throw Error("密码错误");
    const r = await decMetaStream(m, fc, fl, key, 33);
    ent = r.ent;
    ds = r.ds;
  } else {
    const fc = (hdr[4] << 8) | hdr[5];
    const r = await decMetaStream(m, fc, 0, null, 6);
    ent = r.ent;
    ds = r.ds;
    key = null;
  }

  return { entries: ent, key, meta: m, dataStart: ds };
}
