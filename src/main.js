// ══════════════════════════════════════════════
// F2P_pure · 流式隐写 · StreamSaver 直写 · 按需解码
// ══════════════════════════════════════════════

import "./style.css";
import streamSaver from "streamsaver";

streamSaver.mitm = "mitm.html";

const $ = (id) => document.getElementById(id);
const encInput = $("encInput"),
  encDrop = $("encDrop"),
  fileList = $("fileList"),
  encBtn = $("encBtn"),
  clearBtn = $("clearBtn");
const encProg = $("encProg"),
  encBar = $("encBar"),
  encStatus = $("encStatus"),
  encResult = $("encResult"),
  imgInfo = $("imgInfo"),
  dlLink = $("dlLink");
const decInput = $("decInput"),
  decDrop = $("decDrop"),
  decText = $("decText"),
  decHint = $("decHint"),
  decBtn = $("decBtn"),
  decClearBtn = $("decClearBtn");
const decProg = $("decProg"),
  decBar = $("decBar"),
  decStatus = $("decStatus"),
  decResult = $("decResult"),
  decFiles = $("decFiles");
const tc = $("toastContainer"),
  chunkSizeInput = $("chunkSize"),
  tabEnc = $("tabEnc"),
  tabDec = $("tabDec"),
  encSection = $("encSection"),
  decSection = $("decSection");

tabEnc.addEventListener("click", () => {
  tabEnc.classList.add("active");
  tabDec.classList.remove("active");
  encSection.style.display = "";
  decSection.style.display = "none";
});
tabDec.addEventListener("click", () => {
  tabDec.classList.add("active");
  tabEnc.classList.remove("active");
  decSection.style.display = "";
  encSection.style.display = "none";
});

function toast(m, d = 2500) {
  const e = document.createElement("div");
  e.className = "toast";
  e.textContent = m;
  tc.appendChild(e);
  setTimeout(() => {
    e.classList.add("out");
    setTimeout(() => e.remove(), 250);
  }, d);
}
function fmt(b) {
  return b < 1024
    ? b + " B"
    : b < 1048576
      ? (b / 1024).toFixed(1) + " KB"
      : (b / 1048576).toFixed(2) + " MB";
}
const TE = new TextEncoder(),
  TD = new TextDecoder();

function readSlice(blob, start, end) {
  return new Promise((rs, rj) => {
    const r = new FileReader();
    r.onload = () => rs(new Uint8Array(r.result));
    r.onerror = () => rj(r.error);
    r.readAsArrayBuffer(blob.slice(start, end));
  });
}

async function readChunk(file, start, end, trySize) {
  try {
    const buf = await file.slice(start, end).arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    // arrayBuffer 失败，降级到 FileReader
    try {
      return await readSlice(file, start, end);
    } catch {
      // FileReader 也失败，减半分块重试
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
}

// ═══════════════════════════════════════ 流式 BMP 编码 ══

function buildBMPStream(payloadSize, onRow) {
  const ps = 8 + payloadSize; // 4 = marker + 2 = fc
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
  let col = 0;
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
  }

  // pad 完成后等待所有写入完成
  function flushAll() {
    return writeChain;
  }

  return {
    w,
    h,
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
      }
    },
    flushAll() {
      return writeChain;
    },
  };
}

// ═══════════════════════════════════════ 流式 BMP 解码 ══

async function readBmpHeader(blob) {
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

// 按行读取 payload 字节 (局部缓存)
async function readPayload(m, bp, len) {
  const chMap = [2, 1, 0];
  const out = new Uint8Array(len);
  let off = 0;
  const { w, po, rb, blob } = m;
  let cacheIdx = -1,
    cacheRow = null;
  while (off < len) {
    const pxIdx = ((bp + off) / 3) | 0;
    const row = (pxIdx / w) | 0;
    const maxInRow = (w - (pxIdx % w)) * 3;
    const want = Math.min(len - off, maxInRow);
    if (cacheIdx !== row) {
      cacheRow = new Uint8Array(
        await blob.slice(po + row * rb, po + (row + 1) * rb).arrayBuffer(),
      );
      cacheIdx = row;
    }
    for (let j = 0; j < want; j++) {
      const pIdx = ((bp + off + j) / 3) | 0;
      out[off + j] = cacheRow[(pIdx % w) * 3 + chMap[(bp + off + j) % 3]];
    }
    off += want;
  }
  return out;
}

// 解析 payload 元信息
async function decMetaStream(m) {
  const hdr = await readPayload(m, 0, 8);
  const marker = (hdr[0] << 24) | (hdr[1] << 16) | (hdr[2] << 8) | hdr[3];
  const newFmt = marker === 0x46325031; // "F2P1"
  const fc = newFmt
    ? ((hdr[4] << 24) | (hdr[5] << 16) | (hdr[6] << 8) | hdr[7]) >>> 0
    : (hdr[4] << 8) | hdr[5];

  const ms = newFmt ? 8 : 6;
  let buf = await readPayload(m, ms, 65536);
  let off = 0;
  const ent = [];
  for (let i = 0; i < fc; i++) {
    while (off + (newFmt ? 10 : 6) > buf.length) {
      const more = await readPayload(m, ms + buf.length, 65536);
      if (buf.length >= 0x10000000) throw Error("元信息过大");
      const mg = new Uint8Array(buf.length + more.length);
      mg.set(buf);
      mg.set(more, buf.length);
      buf = mg;
    }
    const nl = (buf[off] << 8) | buf[off + 1];
    off += 2;
    const nm = TD.decode(buf.subarray(off, off + nl));
    off += nl;
    let dl;
    if (newFmt) {
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
    ent.push({ name: nm, size: dl });
  }
  const sizeField = newFmt ? 8 : 4;
  const payloadSize = ent.reduce(
    (s, f) => s + 2 + TE.encode(f.name).length + sizeField + f.size,
    0,
  );
  return { ent, payloadSize, m, ds: ms + off };
}

// ═══════════════════════════════════════ 文件选择 ══

let sel = [];
function addFs(fs) {
  const inc = Array.from(fs),
    ex = new Set(sel.map((f) => f.name + "|" + f.size));
  let a = 0;
  for (const f of inc) {
    const k = f.name + "|" + f.size;
    if (ex.has(k)) continue;
    sel.push(f);
    ex.add(k);
    a++;
  }
  updUI();
  if (a) toast("📎 已添加 " + a + " 个");
}
function rmF(i) {
  sel.splice(i, 1);
  updUI();
}
function updUI() {
  if (!sel.length) {
    fileList.style.display = "none";
    clearBtn.style.display = "none";
    encBtn.disabled = !0;
    encStatus.textContent = "等待文件选择…";
    encStatus.className = "status";
    return;
  }
  const t = sel.reduce((s, f) => s + f.size, 0);
  clearBtn.style.display = "inline-block";
  let e = "";
  for (let i = 0; i < sel.length; i++) {
    const n = sel[i];
    e +=
      '<div class="file-item"><span class="name">' +
      n.name +
      '</span><span class="size">' +
      fmt(n.size) +
      '</span><button class="file-remove" data-idx="' +
      i +
      '">✕</button></div>';
  }
  e +=
    '<div class="file-summary"><span>共 ' +
    sel.length +
    " 个</span><span>" +
    fmt(t) +
    "</span></div>";
  fileList.innerHTML = e;
  fileList.style.display = "block";
  fileList.querySelectorAll(".file-remove").forEach((b) => {
    b.addEventListener("click", function () {
      rmF(+this.dataset.idx);
    });
  });
  const n = Math.max(
    4,
    Math.ceil(Math.sqrt(Math.ceil((t + sel.length * 30 + 4) / 3))),
  );
  encStatus.textContent =
    "已选 " + sel.length + " 个 (" + fmt(t) + ")，预估 " + n + "×" + n + " px";
  encStatus.className = "status";
  encBtn.disabled = !1;
}
encInput.addEventListener("change", function () {
  const f = Array.from(this.files);
  this.value = "";
  if (f.length) addFs(f);
});
clearBtn.addEventListener("click", () => {
  sel = [];
  updUI();
  encResult.classList.remove("show");
});
let ed = 0;
encDrop.addEventListener("dragenter", (e) => {
  e.preventDefault();
  ed++;
  encDrop.classList.add("drag-over");
});
encDrop.addEventListener("dragover", (e) => e.preventDefault());
encDrop.addEventListener("dragleave", (e) => {
  ed--;
  if (!ed) encDrop.classList.remove("drag-over");
});
encDrop.addEventListener("drop", (e) => {
  e.preventDefault();
  ed = 0;
  encDrop.classList.remove("drag-over");
  if (!e.dataTransfer.files.length) return;
  if (e.dataTransfer.items)
    for (const it of e.dataTransfer.items) {
      const en = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null;
      if (en && en.isDirectory)
        return void toast("⚠️ 不支持文件夹，请选择文件");
    }
  addFs(Array.from(e.dataTransfer.files));
});

// ═══════════════════════════════════════ 编码 ══

function sp(w, b, p) {
  w.classList.add("on");
  b.style.width = p + "%";
}
function hp(w, b) {
  w.classList.remove("on");
  b.style.width = "0%";
}

async function doEnc() {
  if (!sel.length) return;
  const t0 = performance.now();
  try {
    encResult.classList.remove("show");
    dlLink.style.display = "";
    sp(encProg, encBar, 5);
    let ms = 0,
      ds = 0;
    for (const f of sel)
      ((ms += 2 + TE.encode(f.name).length + 8), (ds += f.size));
    sp(encProg, encBar, 15);

    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    const ts = d.getFullYear() + pad(d.getMonth()+1) + pad(d.getDate()) + 'T' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
    const fileStream = streamSaver.createWriteStream("F2P_" + ts + ".bmp");
    const writer = fileStream.getWriter();
    let cancelled = false;

    const bmp = buildBMPStream(ms + ds, (row) => {
        writer.write(row).catch(() => {
          cancelled = true;
        });
      }),
      { w, h } = bmp;

    await writer.write(bmp.header).catch(() => {
      cancelled = true;
    });
    if (cancelled) throw Error("下载已取消");

    bmp.w32(0x46325031); // "F2P1" version=1
    bmp.w32(sel.length);
    for (const f of sel) {
      const nb = TE.encode(f.name);
      bmp.w16(nb.length);
      bmp.wChunk(nb);
      bmp.w64(f.size);
    }

    let processed = 0,
      fileIdx = 0;
    for (const f of sel) {
      encStatus.innerHTML =
        "<span>⏳ (" +
        ++fileIdx +
        "/" +
        sel.length +
        ") " +
        fmt(processed) +
        "/" +
        fmt(ds) +
        '</span><span style="text-align:right">' +
        f.name +
        "</span>";
      sp(encProg, encBar, 20 + (((processed / ds) * 60) | 0));
      try {
        const chunk = (parseInt(chunkSizeInput.value) || 64) * 1024;
        let pos = 0;
        while (pos < f.size) {
          const end = Math.min(pos + chunk, f.size);
          const buf = await readChunk(f, pos, end, chunk);
          bmp.wChunk(buf);
          pos = end;
        }
      } catch (e) {
        console.error(e);
        throw Error("读取失败: " + f.name);
      }
      if (cancelled) throw Error("下载已取消");
      processed += f.size;
      await new Promise((r) => setTimeout(r, 50));
    }

    sp(encProg, encBar, 85);
    if (cancelled) throw Error("下载已取消");
    bmp.pad();
    await bmp.flushAll();
    if (cancelled) throw Error("下载已取消");
    await writer.close().catch(() => {});

    const hx = Array.from(bmp.headBytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ");
    imgInfo.textContent =
      "尺寸: " + w + "×" + h + " | " + fmt(ms + ds) + " | 前16B: " + hx;
    dlLink.textContent = "💾 已保存";
    dlLink.style.pointerEvents = "none";
    dlLink.href = "#";
    encResult.classList.add("show");
    encStatus.textContent =
      "✅ " +
      sel.length +
      " 个文件 · " +
      fmt(ms + ds) +
      " · " +
      ((performance.now() - t0) / 1e3).toFixed(1) +
      "s";
    encStatus.className = "status ok";
    sp(encProg, encBar, 100);
    setTimeout(() => hp(encProg, encBar), 1500);
    toast("✅ BMP 已保存");
  } catch (e) {
    console.error(e);
    const msg = e.message || "";
    if (
      msg.includes("abort") ||
      msg.includes("Abort") ||
      msg.includes("cancel") ||
      msg.includes("close") ||
      msg.includes("取消")
    ) {
      encStatus.textContent = "⏹ 下载已取消";
      encStatus.className = "status";
    } else {
      encStatus.textContent = "❌ " + msg;
      encStatus.className = "status err";
    }
    hp(encProg, encBar);
  }
}
encBtn.addEventListener("click", doEnc);

// ═══════════════════════════════════════ 解码 ══

let df = null,
  decMeta = null,
  dd = 0;
decDrop.addEventListener("dragenter", (e) => {
  e.preventDefault();
  dd++;
  decDrop.classList.add("drag-over");
});
decDrop.addEventListener("dragover", (e) => e.preventDefault());
decDrop.addEventListener("dragleave", (e) => {
  dd--;
  if (!dd) decDrop.classList.remove("drag-over");
});
decDrop.addEventListener("drop", (e) => {
  e.preventDefault();
  dd = 0;
  decDrop.classList.remove("drag-over");
  const f = e.dataTransfer.files[0];
  if (f) {
    decInput.files = e.dataTransfer.files;
    decInput.dispatchEvent(new Event("change"));
  } else {
    toast("⚠️ 请拖放文件");
  }
});
decInput.addEventListener("change", function () {
  if (this.files.length) {
    df = this.files[0];
    decText.textContent = df.name;
    decHint.textContent = fmt(df.size) + " · BMP";
    decBtn.disabled = !1;
    decResult.classList.remove("show");
    decMeta = null;
  } else {
    df = null;
    decText.textContent = "拖放图片，或点击选择";
    decHint.textContent = "通过文件头自动识别";
    decBtn.disabled = !0;
  }
});
decClearBtn.addEventListener("click", () => {
  df = null;
  decMeta = null;
  decInput.value = "";
  decText.textContent = "拖放图片，或点击选择";
  decHint.textContent = "通过文件头自动识别";
  decBtn.disabled = !0;
  decResult.classList.remove("show");
  decStatus.textContent = "等待图片上传…";
  decStatus.className = "status";
});

async function doDec() {
  if (!df) return;
  const t0 = performance.now();
  decStatus.textContent = "⏳ 读取元信息…";
  decStatus.className = "status";
  sp(decProg, decBar, 10);
  try {
    const m = await readBmpHeader(df);
    sp(decProg, decBar, 20);
    const { ent, payloadSize, ds } = await decMetaStream(m);
    decMeta = { m, ent, payloadSize, ds };
    sp(decProg, decBar, 80);
    let h = "";
    for (let i = 0; i < ent.length; i++) {
      const f = ent[i];
      h +=
        '<div class="decode-file-item"><span class="name">📄 ' +
        f.name +
        '</span><span class="size">' +
        fmt(f.size) +
        '</span><button class="dl-btn" data-idx="' +
        i +
        '" data-fn="' +
        f.name.replace(/"/g, "&quot;") +
        '">⬇️</button></div>';
    }
    decFiles.innerHTML = h;
    decResult.classList.add("show");
    decStatus.textContent =
      "✅ " +
      ent.length +
      " 个文件 · " +
      fmt(payloadSize) +
      " · " +
      ((performance.now() - t0) / 1e3).toFixed(1) +
      "s";
    decStatus.className = "status ok";
    sp(decProg, decBar, 100);
    setTimeout(() => hp(decProg, decBar), 1500);
    toast("✅ 解码成功");

    decFiles.querySelectorAll(".dl-btn").forEach((b) => {
      b.addEventListener("click", async function () {
        const i = +this.dataset.idx,
          fn = this.dataset.fn;
        const { m, ent, ds } = decMeta;
        let prev = 0;
        for (let j = 0; j < i; j++) prev += ent[j].size;
        try {
          const fileStream = streamSaver.createWriteStream(fn);
          const writer = fileStream.getWriter();
          const chunkSize = (parseInt(chunkSizeInput.value) || 64) * 1024;
          const offset = ds + prev;
          const size = ent[i].size;
          let remaining = size,
            pos = offset;
          while (remaining > 0) {
            const take = Math.min(remaining, chunkSize);
            const data = await readPayload(m, pos, take);
            await writer.write(data);
            remaining -= take;
            pos += take;
          }
          await writer.close().catch(() => {});
          toast("⬇️ " + fn + " · " + fmt(ent[i].size));
        } catch (e) {
          console.error(e);
          toast("⏹ 下载已取消");
        }
      });
    });
  } catch (e) {
    console.error(e);
    decStatus.textContent = "❌ " + e.message;
    decStatus.className = "status err";
    hp(decProg, decBar);
  }
}
decBtn.addEventListener("click", doDec);
