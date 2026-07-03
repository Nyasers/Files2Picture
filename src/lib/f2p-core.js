// ═══════════════════════════════════════════════
// F2P 核心库 — 页面 + SW 共用
// ═══════════════════════════════════════════════
"use strict";

const _ctx = {
  e: new TextEncoder(),
};

export function fmt(b) {
  return b < 1024
    ? b + " B"
    : b < 1048576
      ? (b / 1024).toFixed(1) + " KB"
      : b < 1073741824
        ? (b / 1048576).toFixed(2) + " MB"
        : b < 1099511627776
          ? (b / 1073741824).toFixed(2) + " GB"
          : (b / 1099511627776).toFixed(2) + " TB";
}

// ── 版本魔数 ──

export const F2P1 = 0x46325031;
export const F2P2 = 0x46325032;
export const F2P3 = 0x46325033;
export const F2P4 = 0x46325034;
export const F2P5 = 0x46325035;
export const F2P6 = 0x46325036;

// ── 加密工具 ──

export async function deriveEncKey(password, salt, iterations, extractable) {
  const pwdKey = await crypto.subtle.importKey(
    "raw",
    _ctx.e.encode(password || ""),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: iterations || 10000, hash: "SHA-256" },
    pwdKey,
    { name: "AES-CTR", length: 256 },
    !!extractable,
    ["encrypt", "decrypt"],
  );
}

function buildCtr(counter, blockOff, bits) {
  const ctr = new Uint8Array(16);
  ctr.set(counter, 0);
  const cBits = normalizeBits(bits);
  // counter 至少占 1 个完整字节（ceil），多出的位用掩码截断
  const cBytes = Math.ceil(cBits / 8);
  // 只操作最后 cBytes 字节，与 WebCrypto length 语义一致
  let val = 0n;
  const start = 16 - cBytes;
  for (let i = start; i < 16; i++) {
    val = (val << 8n) | BigInt(ctr[i]);
  }
  val += BigInt(Math.trunc(blockOff));
  // 截断到 counter 宽度，防止进位传播到 nonce 区域
  if (cBits < 128) {
    const mask = (1n << BigInt(cBits)) - 1n;
    val &= mask;
  }
  for (let i = 15; i >= start; i--) {
    ctr[i] = Number(val & 0xffn);
    val >>= 8n;
  }
  // 非整字节时保留最高位 counter 字节中的 nonce 位
  if (cBits < 128) {
    const partialBits = cBits % 8;
    if (partialBits !== 0) {
      const mask = (1 << partialBits) - 1;
      ctr[start] = (counter[start] & ~mask) | (ctr[start] & mask);
    }
  }
  return ctr;
}

function normalizeBits(bits) {
  return Math.max(1, Math.min(128, bits || 128));
}

export async function aesEncrypt(plain, key, counter, blockOff, bits) {
  const nb = normalizeBits(bits);
  return new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-CTR",
        counter: buildCtr(counter, blockOff, nb),
        length: nb,
      },
      key,
      plain,
    ),
  );
}

export async function aesDecrypt(data, key, counter, blockOff, bits) {
  const nb = normalizeBits(bits);
  return new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "AES-CTR",
        counter: buildCtr(counter, blockOff, nb),
        length: nb,
      },
      key,
      data,
    ),
  );
}

// ── 文件读取 ──

export async function readChunk(file, start, end, trySize) {
  try {
    return new Uint8Array(await file.slice(start, end).arrayBuffer());
  } catch {
    const half = Math.max(trySize >>> 1, 1024);
    if (half < trySize && start + half < end) {
      const a = await readChunk(file, start, start + half, half);
      const b = await readChunk(file, start + half, end, half);
      const mg = new Uint8Array(a.length + b.length);
      mg.set(a);
      mg.set(b, a.length);
      return mg;
    }
    throw new Error("读取文件失败: " + file.name + " @" + start + "-" + end);
  }
}

// ── 容器格式检测 ──

export async function detectContainerType(file) {
  try {
    const buf = await file.slice(0, 2).arrayBuffer();
    const v = new DataView(buf);
    if (v.getUint8(0) === 0x42 && v.getUint8(1) === 0x4d) return "bmp";
    return null;
  } catch {
    return null;
  }
}

// ── BMP 编码（32-bit BGRA 原生顺序）──

export function buildBMPStream(payloadSize, onRow) {
  const BPP = 4;
  const ps = 8 + payloadSize;
  // 最大完全平方数 k²，满足 k²×4 ≤ ps（零填充浪费）
  const k = Math.max(1, Math.floor(Math.sqrt(Math.floor(ps / BPP))));
  const w = k,
    h = k;
  const rb = w * BPP; // 行字节数（32bit 无 padding）
  const pds = rb * h; // 像素区大小 = k² × 4
  const tailSize = ps - pds; // 尾巴字节数
  const bfSize = 14 + 40 + pds; // BMP header 声明的文件大小（54 + 4k²）
  const fs = 14 + 40 + ps; // 实际文件大小（54 + ps）

  const hdr = new ArrayBuffer(54);
  const v = new DataView(hdr);
  v.setUint8(0, 0x42);
  v.setUint8(1, 0x4d);
  // bfSize 是 32-bit 字段，>4GB 时截断为 0xFFFFFFFF（BMP 解析器一般不用这个字段）
  v.setUint32(2, bfSize > 0xffffffff ? 0xffffffff : bfSize, true);
  v.setUint16(6, 0, true);
  v.setUint16(8, 0, true);
  v.setUint32(10, 54, true);
  v.setUint32(14, 40, true);
  v.setInt32(18, w, true);
  v.setInt32(22, -h, true);
  v.setUint16(26, 1, true);
  v.setUint16(28, 32, true);
  v.setUint32(30, 0, true);
  v.setUint32(34, pds > 0xffffffff ? 0xffffffff : pds, true);
  v.setInt32(38, 2835, true);
  v.setInt32(42, 2835, true);
  v.setUint32(46, 0, true);
  v.setUint32(50, 0, true);

  let rowBuf = new Uint8Array(rb);
  let col = 0,
    rowIdx = 0;
  let bp = 0;
  let writeChain = Promise.resolve();
  const tailBuf = new Uint8Array(tailSize);
  let tailOff = 0;

  function flushRow() {
    if (onRow) {
      const copy = new Uint8Array(rowBuf);
      writeChain = writeChain.then(() => onRow(copy));
    }
    rowBuf = new Uint8Array(rb);
    col = 0;
    rowIdx++;
  }

  return {
    w,
    h,
    pds,
    fs,
    header: new Uint8Array(hdr),
    wChunk(arr) {
      let i = 0,
        n = arr.length;
      while (i < n && bp < ps) {
        if (bp < pds) {
          // ── 像素区内：逐像素写入 ──
          if (bp % BPP === 0 && i + BPP <= n && bp + BPP <= pds) {
            const off = col * BPP;
            // BGRA 原生：B=0, G=1, R=2, A=3
            rowBuf[off] = arr[i];
            rowBuf[off + 1] = arr[i + 1];
            rowBuf[off + 2] = arr[i + 2];
            rowBuf[off + 3] = arr[i + 3];
            i += BPP;
            bp += BPP;
            col++;
          } else {
            const off = col * BPP;
            rowBuf[off + (bp % BPP)] = arr[i];
            i++;
            bp++;
            if (bp % BPP === 0) col++;
          }
          if (col >= w) flushRow();
        } else {
          // ── 尾巴区：直接缓存，不行对齐 ──
          const take = Math.min(n - i, ps - bp);
          tailBuf.set(arr.subarray(i, i + take), tailOff);
          tailOff += take;
          i += take;
          bp += take;
        }
      }
    },
    w8(v) {
      this.wChunk(new Uint8Array([v]));
    },
    w16(v) {
      this.wChunk(new Uint8Array([v >>> 8, v & 255]));
    },
    w32(v) {
      this.wChunk(new Uint8Array([v >>> 24, v >>> 16, v >>> 8, v & 255]));
    },
    w64(v) {
      const hi = Math.floor(v / 0x100000000) >>> 0;
      const lo = v >>> 0;
      this.wChunk(
        new Uint8Array([
          (hi >>> 24) & 0xff,
          (hi >>> 16) & 0xff,
          (hi >>> 8) & 0xff,
          hi & 0xff,
          (lo >>> 24) & 0xff,
          (lo >>> 16) & 0xff,
          (lo >>> 8) & 0xff,
          lo & 0xff,
        ]),
      );
    },
    pad() {
      // 清尾行
      if (col > 0 && onRow) {
        const copy = new Uint8Array(rowBuf);
        writeChain = writeChain.then(() => onRow(copy));
        rowIdx++;
      }
      // 填充剩余空行（仅当 pds > ps 时触发，但新方案 pds ≤ ps 不会走到这里）
      while (rowIdx < h && onRow) {
        const copy = new Uint8Array(rb);
        writeChain = writeChain.then(() => onRow(copy));
        rowIdx++;
      }
      // 返回尾巴数据，调用者自行压入流
      return tailBuf;
    },
    flushAll() {
      return writeChain;
    },
  };
}

// ── BMP 头读取 ──

export async function readBmpHeader(blob) {
  const buf = await blob.slice(0, 54).arrayBuffer();
  const v = new DataView(buf);
  if (v.getUint8(0) !== 0x42 || v.getUint8(1) !== 0x4d) throw Error("不是 BMP");
  const bpp = v.getUint16(28, true);
  if (bpp !== 24 && bpp !== 32) throw Error("仅支持 24/32-bit BMP");
  const po = v.getUint32(10, true);
  if (po !== 54) throw Error("像素偏移异常，仅支持标准 BMP");
  const w = v.getInt32(18, true);
  const hr = v.getInt32(22, true);
  const h = hr < 0 ? -hr : hr;
  const bps = (bpp / 8) | 0;
  const st = w * bps;
  const rp = bpp === 32 ? 0 : (4 - (st % 4)) % 4;
  return { w, h, bpp, rb: st + rp, po, blob };
}

// ── BMP 像素读取 ──
// chMap: null/null → BGRA 原生（32-bit 直接偏移，24-bit BGR 原生）
// chMap: [2,1,0] → 24-bit 旧格式
// chMap: [2,1,0,3] → 32-bit 旧格式（F2P2/F2P3）

export async function readPayload(m, bp, len, chMap) {
  const bpp = m.bpp || 32;
  const bps = (bpp / 8) | 0;
  const out = new Uint8Array(len);
  if (len === 0) return out;
  const { w, po, rb, blob } = m;

  // 32bit 无 channel mapping：像素区 + 尾巴连续存在文件中，线性读即可
  if (bpp === 32 && (!chMap || chMap.length === 0)) {
    try {
      return new Uint8Array(
        await blob.slice(po + bp, po + bp + len).arrayBuffer(),
      );
    } catch {
      throw new Error("读取 BMP 像素/尾巴数据失败");
    }
  }

  // 旧格式（24bit 或 channel mapping）：只能读像素区内
  const pxEnd = ((bp + len - 1) / bps) | 0;
  const rowEnd = (pxEnd / w) | 0;
  const fileStart = po + 0;
  const fileEnd = po + (rowEnd + 1) * rb;

  let buf;
  try {
    buf = new Uint8Array(await blob.slice(fileStart, fileEnd).arrayBuffer());
  } catch {
    throw new Error("读取 BMP 像素数据失败");
  }

  const useMap = chMap && chMap.length > 0;
  for (let off = 0; off < len; off++) {
    const pOff = bp + off;
    const pxIdx = (pOff / bps) | 0;
    const row = (pxIdx / w) | 0;
    const pInRow = pxIdx % w;
    const chOff = useMap ? chMap[pOff % bps] : pOff % bps;
    out[off] = buf[row * rb + pInRow * bps + chOff];
  }
  return out;
}

// ── 缓冲区扩展（各解码器通用）──

export async function extendBuffer(buf, more, fileCount) {
  if (buf.length >= 0x10000000)
    throw Error(
      "元信息大小超过上限 (256MB)，" +
        (fileCount != null
          ? "当前 " + fileCount + " 个文件"
          : "可能是文件数量过多") +
        "，请确认 BMP 格式正确",
    );
  const mg = new Uint8Array(buf.length + more.length);
  mg.set(buf);
  mg.set(more, buf.length);
  return mg;
}
