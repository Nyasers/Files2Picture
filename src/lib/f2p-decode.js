// ═══════════════════════════════════════════════
// F2P 解码外观 — 自动识别容器格式并派发
// ═══════════════════════════════════════════════

import { detectContainerType } from "./f2p-core.js";
import { detectTiff, decodeTiff } from "./tiff-decode.js";
import { decodeBmp, quickDetectBmp } from "./bmp-decode.js";

/**
 * 快速检测图片格式，返回人类可读的描述
 * @param {File} file
 * @returns {Promise<string|null>}
 */
export async function quickDetect(file) {
  const tiff = await detectTiff(file);
  if (tiff) return "TIFF · F2P4";
  const bmp = await quickDetectBmp(file);
  return bmp || null;
}

/**
 * 统一解码入口
 * @param {File} file - 图片文件（BMP 或 TIFF）
 * @param {string} password - 密码
 * @returns {Promise<{entries:Array, key:CryptoKey|null, meta:object|null, dataStart:number}>}
 * @throws 密码错误 / 格式不支持 / 数据损坏
 */
export async function decodeContainer(file, password) {
  const type = await detectContainerType(file);

  if (type === "tiff") {
    const result = await decodeTiff(file, password);
    return { ...result, meta: null, dataStart: 0 };
  }

  if (type === "bmp") {
    return await decodeBmp(file, password);
  }

  throw Error("不支持的图片格式");
}
