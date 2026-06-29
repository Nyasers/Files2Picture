// ═══════════════════════════════════════════════
// F2P 核心库 — 页面 + SW 共用
// ═══════════════════════════════════════════════

const _ctx = {
  e: new TextEncoder(),
  d: new TextDecoder(),
};

export function fmt(b) {
  return b < 1024
    ? b + " B"
    : b < 1048576
      ? (b / 1024).toFixed(1) + " KB"
      : (b / 1048576).toFixed(2) + " MB";
}

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

function buildCtr(nonce, blockOff) {
  const ctr = new Uint8Array(16);
  ctr.set(nonce, 0);
  const v = blockOff >>> 0;
  ctr[12] = (v >>> 24) & 0xff;
  ctr[13] = (v >>> 16) & 0xff;
  ctr[14] = (v >>> 8) & 0xff;
  ctr[15] = v & 0xff;
  return ctr;
}

export async function aesEncrypt(plain, key, nonce, blockOff) {
  return new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-CTR", counter: buildCtr(nonce, blockOff), length: 32 },
      key,
      plain,
    ),
  );
}

export async function aesDecrypt(data, key, nonce, blockOff) {
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-CTR", counter: buildCtr(nonce, blockOff), length: 32 },
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
    // 减半分块重试（串行，避免并行加倍内存）
    const half = Math.max(trySize >>> 1, 1024);
    if (half < trySize && start + half < end) {
      const a = await readChunk(file, start, start + half, half);
      const b = await readChunk(file, start + half, end, half);
      const mg = new Uint8Array(a.length + b.length);
      mg.set(a);
      mg.set(b, a.length);
      return mg;
    }
    throw new Error("无法读取文件");
  }
}

// ── BMP 编码 ──

export function buildBMPStream(payloadSize, onRow) {
  const ps = 8 + payloadSize;
  const np = Math.ceil(ps / 3);
  const sz = Math.max(4, Math.ceil(Math.sqrt(np)));
  const w = sz,
    h = sz;
  const st = w * 3;
  const rp = (4 - (st % 4)) % 4;
  const rb = st + rp;
  const pds = rb * h;
  const fs = 14 + 40 + pds;

  const hdr = new ArrayBuffer(54);
  const v = new DataView(hdr);
  v.setUint8(0, 0x42);
  v.setUint8(1, 0x4d);
  v.setUint32(2, fs, true);
  v.setUint16(6, 0, true);
  v.setUint16(8, 0, true);
  v.setUint32(10, 54, true);
  v.setUint32(14, 40, true);
  v.setInt32(18, w, true);
  v.setInt32(22, -h, true);
  v.setUint16(26, 1, true);
  v.setUint16(28, 24, true);
  v.setUint32(30, 0, true);
  v.setUint32(34, pds, true);
  v.setInt32(38, 2835, true);
  v.setInt32(42, 2835, true);
  v.setUint32(46, 0, true);
  v.setUint32(50, 0, true);

  let rowBuf = new Uint8Array(rb);
  let col = 0,
    rowIdx = 0;
  let bp = 0;
  let headBuf = [];
  const ch = [2, 1, 0];
  let writeChain = Promise.resolve();

  function flushRow() {
    if (onRow) {
      const copy = new Uint8Array(rowBuf);
      writeChain = writeChain.then(() => onRow(copy));
    }
    rowBuf = new Uint8Array(rb);
    col = 0;
    rowIdx++;
  }

  function flushAll() {
    return writeChain;
  }

  return {
    w,
    h,
    pds,
    fs,
    header: new Uint8Array(hdr),
    get headBytes() {
      return new Uint8Array(headBuf);
    },
    wChunk(arr) {
      let i = 0,
        n = arr.length;
      while (i < n && bp < ps) {
        if (bp % 3 === 0 && i + 3 <= n && bp + 3 <= ps) {
          const off = col * 3;
          rowBuf[off + 2] = arr[i];
          rowBuf[off + 1] = arr[i + 1];
          rowBuf[off + 0] = arr[i + 2];
          for (let j = 0; j < 3 && headBuf.length < 16; j++)
            headBuf.push(arr[i + j]);
          i += 3;
          bp += 3;
          col++;
        } else {
          const off = col * 3;
          rowBuf[off + ch[bp % 3]] = arr[i];
          if (headBuf.length < 16) headBuf.push(arr[i]);
          i++;
          bp++;
          if (bp % 3 === 0) col++;
        }
        if (col >= w) flushRow();
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
      if (bp < ps) this.wChunk(new Uint8Array(ps - bp));
      if (col > 0 && onRow) {
        const copy = new Uint8Array(rowBuf);
        writeChain = writeChain.then(() => onRow(copy));
        rowIdx++;
      }
      while (rowIdx < h && onRow) {
        const copy = new Uint8Array(rb);
        writeChain = writeChain.then(() => onRow(copy));
        rowIdx++;
      }
    },
    flushAll() {
      return writeChain;
    },
  };
}

// ── BMP 解码 ──

export async function readBmpHeader(blob) {
  const buf = await blob.slice(0, 54).arrayBuffer();
  const v = new DataView(buf);
  if (v.getUint8(0) !== 0x42 || v.getUint8(1) !== 0x4d) throw Error("不是 BMP");
  if (v.getUint16(28, true) !== 24) throw Error("仅支持 24-bit BMP");
  const po = v.getUint32(10, true);
  const w = v.getInt32(18, true);
  const hr = v.getInt32(22, true);
  const h = hr < 0 ? -hr : hr;
  const st = w * 3;
  const rp = (4 - (st % 4)) % 4;
  return { w, h, rb: st + rp, po, blob };
}

export async function readPayload(m, bp, len) {
  const chMap = [2, 1, 0];
  const out = new Uint8Array(len);
  if (len === 0) return out;
  const { w, po, rb, blob } = m;

  const pxStart = (bp / 3) | 0;
  const pxEnd = ((bp + len - 1) / 3) | 0;
  const rowStart = (pxStart / w) | 0;
  const rowEnd = (pxEnd / w) | 0;

  const fileStart = po + rowStart * rb;
  const fileEnd = po + (rowEnd + 1) * rb;

  let buf;
  try {
    buf = new Uint8Array(await blob.slice(fileStart, fileEnd).arrayBuffer());
  } catch {
    throw new Error("读取 BMP 像素数据失败");
  }

  for (let off = 0; off < len; off++) {
    const pOff = bp + off;
    const pxIdx = (pOff / 3) | 0;
    const row = (pxIdx / w) | 0;
    const relRow = row - rowStart;
    const pInRow = pxIdx % w;
    const bufOff = relRow * rb + pInRow * 3 + chMap[pOff % 3];
    out[off] = buf[bufOff];
  }

  return out;
}

export async function decMetaStream(m, fc, flags, key, ms) {
  const newFmt = ms > 6;
  const encNameEnc = newFmt && flags & 1;
  const hasNonces = ms >= 29;
  const entryMin = hasNonces
    ? 2 + 8 + 12 + (encNameEnc ? 12 : 0)
    : newFmt
      ? 2 + 8
      : 2 + 4;
  let buf = await readPayload(m, ms, 65536);
  let off = 0;
  const ent = [];

  for (let i = 0; i < fc; i++) {
    while (off + entryMin > buf.length) {
      const more = await readPayload(m, ms + buf.length, 65536);
      if (buf.length >= 0x10000000) throw Error("元信息过大");
      const mg = new Uint8Array(buf.length + more.length);
      mg.set(buf);
      mg.set(more, buf.length);
      buf = mg;
    }
    const nl = (buf[off] << 8) | buf[off + 1];
    off += 2;

    let nm,
      dl,
      nonceData = null;
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
      dl = hi * 0x100000000 + (lo >>> 0);
      off += 8;
      const nonceName = buf.subarray(off, off + 12);
      off += 12;
      const ctr = new Uint8Array(16);
      ctr.set(nonceName, 0);
      const decName = await crypto.subtle.decrypt(
        { name: "AES-CTR", counter: ctr, length: 32 },
        key,
        encName,
      );
      nm = _ctx.d.decode(new Uint8Array(decName));
      nonceData = buf.subarray(off, off + 12);
      off += 12;
    } else {
      nm = _ctx.d.decode(buf.subarray(off, off + nl));
      off += nl;
      if (hasNonces) {
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
        dl = hi * 0x100000000 + (lo >>> 0);
        off += 8;
        nonceData = buf.subarray(off, off + 12);
        off += 12;
      } else if (newFmt) {
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
        dl = hi * 0x100000000 + (lo >>> 0);
        off += 8;
      } else {
        dl =
          ((buf[off] << 24) |
            (buf[off + 1] << 16) |
            (buf[off + 2] << 8) |
            buf[off + 3]) >>>
          0;
        off += 4;
      }
    }

    ent.push({
      name: nm,
      size: dl,
      nonceData: nonceData ? new Uint8Array(nonceData) : null,
    });
  }

  const es = newFmt ? 8 : 4;
  const no = hasNonces ? 12 + (encNameEnc ? 12 : 0) : 0;
  const payloadSize = ent.reduce(
    (s, f) => s + 2 + _ctx.e.encode(f.name).length + es + no + f.size,
    0,
  );
  return { ent, payloadSize, m, ds: ms + off };
}
