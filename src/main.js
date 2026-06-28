// ══════════════════════════════════════════════
// F2P_pure · 纯隐写 · 流式编码 · 按需解码
// ══════════════════════════════════════════════

import "./style.css";

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
const tc = $("toastContainer");

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

// ═══════════════════════════════════════ 流式 BMP 编码 ══

function buildBMP(payloadSize) {
  const ps = 4 + payloadSize,
    np = Math.ceil(ps / 3),
    sz = Math.max(4, Math.ceil(Math.sqrt(np))),
    w = sz,
    h = sz;
  const st = w * 3,
    rp = (4 - (st % 4)) % 4,
    rb = st + rp,
    pds = rb * h,
    fs = 14 + 40 + pds;
  const b = new ArrayBuffer(fs),
    v = new DataView(b),
    px = new Uint8Array(b, 54);
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
  let bp = 0,
    bw = 0;
  const ch = [2, 1, 0];
  return {
    w,
    h,
    rb,
    fs,
    w32(v) {
      this.w8(v >>> 24);
      this.w8(v >>> 16);
      this.w8(v >>> 8);
      this.w8(v & 255);
    },
    w16(v) {
      this.w8(v >>> 8);
      this.w8(v & 255);
    },
    w8(b) {
      if (bp >= ps) return;
      const p = (bp / 3) | 0;
      px[((p / w) | 0) * rb + (p % w) * 3 + ch[bp % 3]] = b;
      bp++;
      bw++;
    },
    wChunk(a) {
      let i = 0;
      const n = a.length;
      while (i + 2 < n && bp + 2 < ps && bp % 3 === 0) {
        const p = (bp / 3) | 0,
          b = ((p / w) | 0) * rb + (p % w) * 3;
        px[b + 2] = a[i];
        px[b + 1] = a[i + 1];
        px[b] = a[i + 2];
        bp += 3;
        bw += 3;
        i += 3;
      }
      while (i < n && bp < ps) {
        if (bp % 3 === 0 && i + 2 < n && bp + 2 < ps) {
          const p = (bp / 3) | 0,
            b = ((p / w) | 0) * rb + (p % w) * 3;
          px[b + 2] = a[i];
          px[b + 1] = a[i + 1];
          px[b] = a[i + 2];
          bp += 3;
          bw += 3;
          i += 3;
        } else {
          const p = (bp / 3) | 0;
          px[((p / w) | 0) * rb + (p % w) * 3 + ch[bp % 3]] = a[i];
          bp++;
          bw++;
          i++;
        }
      }
    },
    pad() {
      while (bp < ps) this.w8(0);
    },
    buf() {
      return b;
    },
  };
}

// ═══════════════════════════════════════ BMP 按需解码 ══
// 格式: [4B plen(不含自身)] [2B fcnt] [所有元信息] [所有数据]

function bmpMeta(ab) {
  const v = new DataView(ab);
  if (v.getUint8(0) !== 0x42 || v.getUint8(1) !== 0x4d) throw Error("不是 BMP");
  if (v.getUint16(28, true) !== 24) throw Error("仅支持 24-bit BMP");
  const po = v.getUint32(10, true),
    w = v.getInt32(18, true),
    hr = v.getInt32(22, true);
  const h = hr < 0 ? -hr : hr,
    st = w * 3,
    rp = (4 - (st % 4)) % 4;
  return { w, h, rb: st + rp, po, ab };
}

function pxRead(m, bp, len) {
  const v = new DataView(m.ab),
    { w, rb, po } = m,
    o = new Uint8Array(len),
    ch = [2, 1, 0];
  for (let i = 0; i < len; i++, bp++) {
    const p = (bp / 3) | 0,
      off = po + ((p / w) | 0) * rb + (p % w) * 3 + ch[bp % 3];
    o[i] = v.getUint8(off);
  }
  return o;
}

function decMeta(m) {
  const pl =
    (pxRead(m, 0, 1)[0] << 24) |
    (pxRead(m, 1, 1)[0] << 16) |
    (pxRead(m, 2, 1)[0] << 8) |
    pxRead(m, 3, 1)[0];
  if (pl < 2) throw Error("payload 为空");
  const fc = (pxRead(m, 4, 1)[0] << 8) | pxRead(m, 5, 1)[0];
  const ms = 6;
  let buf = pxRead(m, ms, Math.min(pl - 2, 65536));
  let off = 0;
  const ent = [];
  for (let i = 0; i < fc; i++) {
    while (off + 6 > buf.length) {
      const more = pxRead(
        m,
        ms + buf.length,
        Math.min(pl - 2 - buf.length, 65536),
      );
      const mg = new Uint8Array(buf.length + more.length);
      mg.set(buf);
      mg.set(more, buf.length);
      buf = mg;
    }
    const nl = (buf[off] << 8) | buf[off + 1];
    off += 2;
    const nm = TD.decode(buf.subarray(off, off + nl));
    off += nl;
    const dl =
      (buf[off] << 24) |
      (buf[off + 1] << 16) |
      (buf[off + 2] << 8) |
      buf[off + 3];
    off += 4;
    ent.push({ name: nm, size: dl });
  }
  return { ent, pl, m, ds: ms + off };
}

function extFile(m, ds, prev, sz) {
  return pxRead(m, ds + prev, sz);
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
    sp(encProg, encBar, 5);
    let ms = 0,
      ds = 0;
    for (const f of sel)
      ((ms += 2 + TE.encode(f.name).length + 4), (ds += f.size));
    const ps = 2 + ms + ds;
    sp(encProg, encBar, 15);
    const bmp = buildBMP(ps),
      { w, h } = bmp;
    bmp.w32(ps);
    bmp.w16(sel.length);
    for (const f of sel) {
      const nb = TE.encode(f.name);
      bmp.w16(nb.length);
      bmp.wChunk(nb);
      bmp.w32(f.size);
    }
    const n = sel.length;
    let d = 0;
    for (const f of sel) {
      encStatus.textContent = "⏳ " + (d + 1) + "/" + n + " " + f.name;
      sp(encProg, encBar, 20 + (((d / n) * 60) | 0));
      try {
        const r = f.stream().getReader();
        while (true) {
          const { value, done: rd } = await r.read();
          if (rd) break;
          bmp.wChunk(value);
        }
      } catch (e) {
        throw Error("读取失败: " + f.name);
      }
      d++;
    }
    sp(encProg, encBar, 85);
    bmp.pad();
    const bl = new Blob([bmp.buf()], { type: "image/bmp" }),
      u = URL.createObjectURL(bl),
      ts = new Date().toISOString().slice(0, 19).replace(/[:-]/g, "");
    const chk = new DataView(bmp.buf());
    let hx = "";
    for (let i = 54; i < 70; i++)
      hx += chk.getUint8(i).toString(16).padStart(2, "0") + " ";
    dlLink.href = u;
    dlLink.download = "F2P_" + ts + ".bmp";
    imgInfo.textContent =
      "尺寸: " + w + "×" + h + " | " + fmt(ps) + " | 前16B: " + hx;
    encResult.classList.add("show");
    encStatus.textContent =
      "✅ " +
      sel.length +
      " 个文件 · " +
      fmt(ps) +
      " · " +
      ((performance.now() - t0) / 1e3).toFixed(1) +
      "s";
    encStatus.className = "status ok";
    sp(encProg, encBar, 100);
    setTimeout(() => hp(encProg, encBar), 1500);
    toast("✅ BMP 已生成");
  } catch (e) {
    encStatus.textContent = "❌ " + e.message;
    encStatus.className = "status err";
    hp(encProg, encBar);
  }
}
encBtn.addEventListener("click", doEnc);

// ═══════════════════════════════════════ 解码 ══

let df = null,
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
  } else {
    df = null;
    decText.textContent = "拖放图片，或点击选择";
    decHint.textContent = "通过文件头自动识别";
    decBtn.disabled = !0;
  }
});
decClearBtn.addEventListener("click", () => {
  df = null;
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
  decStatus.textContent = "⏳ 读取…";
  decStatus.className = "status";
  sp(decProg, decBar, 10);
  try {
    const ab = await df.arrayBuffer();
    sp(decProg, decBar, 30);
    const m = bmpMeta(ab);
    const { ent, pl, ds } = decMeta(m);
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
      fmt(pl) +
      " · " +
      ((performance.now() - t0) / 1e3).toFixed(1) +
      "s";
    decStatus.className = "status ok";
    sp(decProg, decBar, 100);
    setTimeout(() => hp(decProg, decBar), 1500);
    toast("✅ 解码成功");
    decFiles.querySelectorAll(".dl-btn").forEach((b) => {
      b.addEventListener("click", function () {
        const i = +this.dataset.idx,
          fn = this.dataset.fn;
        let p = 0;
        for (let j = 0; j < i; j++) p += ent[j].size;
        try {
          const d = extFile(m, ds, p, ent[i].size),
            bl = new Blob([d]),
            u = URL.createObjectURL(bl),
            a = document.createElement("a");
          a.href = u;
          a.download = fn;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(u);
          toast("⬇️ " + fn + " · " + fmt(ent[i].size));
        } catch (e) {
          toast("❌ 提取失败: " + e.message);
        }
      });
    });
  } catch (e) {
    decStatus.textContent = "❌ " + e.message;
    decStatus.className = "status err";
    hp(decProg, decBar);
  }
}
decBtn.addEventListener("click", doDec);
