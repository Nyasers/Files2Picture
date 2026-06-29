// ═══════════════════════════════════════════════
// 解码 Tab — 图片选择、元信息解析、提取下载
// ═══════════════════════════════════════════════

import {
  fmt,
  readBmpHeader,
  readPayload,
  decMetaStream,
  deriveEncKey,
  aesDecrypt,
} from "./f2p-core.js";
import { $, toast, sendToSW, waitForSw, postViaIframe } from "./sw-client.js";

// ── 解码状态 ──

let decFile = null,
  decEntries = null,
  decKey = null,
  decBmpMeta = null,
  decDataStart = 0;
let dd = 0; // dragenter 计数

// ── DOM ──

const decInput = $("decInput"),
  decDrop = $("decDrop"),
  decText = $("decText"),
  decHint = $("decHint"),
  decBtn = $("decBtn"),
  decClearBtn = $("decClearBtn"),
  decPwdInput = $("decPwdInput"),
  decFileList = $("decFileList");
const chunkSizeInput = $("chunkSize");

// ── 快速检测格式 ──

async function quickDetect(file) {
  try {
    const m = await readBmpHeader(file);
    const hdr = await readPayload(m, 0, 8);
    const marker = (hdr[0] << 24) | (hdr[1] << 16) | (hdr[2] << 8) | hdr[3];
    if (marker === 0x46325033) return "F2P3";
    if (marker === 0x46325032) return "F2P2";
    if (marker === 0x46325031) return "F2P1";
    if (((hdr[0] << 8) | hdr[1]) > 0) return "旧格式";
    return "未知格式";
  } catch {
    return null;
  }
}

// ── 拖放 ──

decDrop.addEventListener("dragenter", (e) => {
  e.preventDefault();
  dd++;
  decDrop.classList.add("drag-over");
});
decDrop.addEventListener("dragover", (e) => e.preventDefault());
decDrop.addEventListener("dragleave", (e) => {
  dd--;
  if (dd <= 0) {
    dd = 0;
    decDrop.classList.remove("drag-over");
  }
});
decDrop.addEventListener("drop", (e) => {
  e.preventDefault();
  dd = 0;
  decDrop.classList.remove("drag-over");
  const f = e.dataTransfer.files[0];
  if (f) {
    decInput.files = e.dataTransfer.files;
    decInput.dispatchEvent(new Event("change"));
  } else toast("⚠️ 请拖放文件");
});

// ── 文件选择 ──

decInput.addEventListener("change", async function () {
  if (!this.files.length) return; // 取消选择不破坏当前状态
  decFile = this.files[0];
  decEntries = null;
  decKey = null;
  decBmpMeta = null;
  decText.textContent = decFile.name;
  decHint.textContent = fmt(decFile.size) + " · BMP";
  decBtn.disabled = false;
  decFileList.style.display = "none";
  decBtn.textContent = "🔎 提取";
  const info = await quickDetect(decFile);
  if (info) decHint.textContent += " · " + info;
});

decClearBtn.addEventListener("click", () => {
  decFile = null;
  decEntries = null;
  decKey = null;
  decBmpMeta = null;
  decInput.value = "";
  decText.textContent = "拖放图片，或点击选择";
  decHint.textContent = "通过文件头自动识别";
  decBtn.disabled = true;
  decFileList.style.display = "none";
});

// ── 提取按钮（解析元信息） ──

decBtn.addEventListener("click", async () => {
  if (!decFile) return;
  const pwd = decPwdInput.value;
  try {
    decBtn.disabled = true;
    decBtn.textContent = "⏳ 解析中…";
    const m = await readBmpHeader(decFile);
    const hdr = await readPayload(m, 0, 8);
    const marker = (hdr[0] << 24) | (hdr[1] << 16) | (hdr[2] << 8) | hdr[3];
    const isEnc = (marker & 0xffffff00) === 0x46325000 && (marker & 0xff) > 1;
    const isF2P1 = marker === 0x46325031;
    let ent, ds, key;

    if (isF2P1) {
      const fc =
        ((hdr[4] << 24) | (hdr[5] << 16) | (hdr[6] << 8) | hdr[7]) >>> 0;
      const r = await decMetaStream(m, fc, 0, null, 8);
      ent = r.ent;
      ds = r.ds;
      key = null;
    } else if (isEnc) {
      const fc =
        ((hdr[4] << 24) | (hdr[5] << 16) | (hdr[6] << 8) | hdr[7]) >>> 0;
      const fl = (await readPayload(m, 8, 1))[0];
      const salt = await readPayload(m, 9, 16);
      const itb = await readPayload(m, 25, 4);
      const iter = (itb[0] << 24) | (itb[1] << 16) | (itb[2] << 8) | itb[3];
      key = await deriveEncKey(pwd, salt, iter, true);
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

    decEntries = ent;
    decKey = key;
    decBmpMeta = m;
    decDataStart = ds;
    renderDecFiles(ent);
    toast("✅ 解码完成，共 " + ent.length + " 个文件");
  } catch (e) {
    toast("❌ " + (e.message || "解析失败"));
    decBtn.disabled = false;
    decBtn.textContent = "🔎 提取";
  }
});

// ── 渲染文件列表 ──

function renderDecFiles(ent) {
  const totalSize = ent.reduce((s, f) => s + f.size, 0);
  let h =
    '<div class="dec-file-header"><span class="dec-file-summary">共 ' +
    ent.length +
    " 个文件 · " +
    fmt(totalSize) +
    '</span><button class="btn-batch-dl" id="batchDlBtn">📥 下载选中</button></div>' +
    '<div class="dec-file-body">' +
    '<div class="file-list-select-all"><label><input type="checkbox" id="selectAllDec" checked> 全选</label></div>';
  for (let i = 0; i < ent.length; i++) {
    const f = ent[i];
    h +=
      '<div class="decode-file-item"><input type="checkbox" class="dec-file-cb" data-idx="' +
      i +
      '" checked>' +
      '<span class="name">📄 ' +
      f.name +
      '</span><span class="size">' +
      fmt(f.size) +
      '</span><button class="dl-btn" data-idx="' +
      i +
      '">⬇️</button></div>';
  }
  h += "</div>";
  decFileList.innerHTML = h;
  decFileList.style.display = "block";
  decBtn.textContent = "✅ 已提取";

  // 全选
  document
    .getElementById("selectAllDec")
    .addEventListener("change", function () {
      document
        .querySelectorAll(".dec-file-cb")
        .forEach((cb) => (cb.checked = this.checked));
    });

  // 批量下载
  document
    .getElementById("batchDlBtn")
    .addEventListener("click", batchDownload);

  // 单个下载按钮
  decFileList.querySelectorAll(".dl-btn").forEach((a) => {
    a.addEventListener("click", singleDownload);
  });
}

// ── 单文件下载 ──

async function singleDownload() {
  const idx = parseInt(this.dataset.idx);
  const ent = decEntries[idx];
  this.disabled = true;
  this.textContent = "⏳";
  try {
    await waitForSw();
    const jobId = Date.now() + "";
    let rawKey = null;
    if (decKey) rawKey = await crypto.subtle.exportKey("raw", decKey);

    sendToSW({
      type: "decode-stream-prepare",
      jobId,
      bmpFile: decFile,
      offset: ent.offset,
      size: ent.size,
      nonce: ent.nonceData ? Array.from(ent.nonceData) : null,
      name: ent.name,
      keyRaw: rawKey ? Array.from(new Uint8Array(rawKey)) : null,
      chunkSize: parseInt(chunkSizeInput.value) || 64,
    });

    const ready = await new Promise((resolve) => {
      const handler = (e) => {
        const d = e.data;
        if (
          d.jobId === jobId &&
          (d.type === "decode-stream-ready" || d.type === "decode-stream-error")
        ) {
          navigator.serviceWorker.removeEventListener("message", handler);
          resolve(d);
        }
      };
      navigator.serviceWorker.addEventListener("message", handler);
      setTimeout(() => {
        navigator.serviceWorker.removeEventListener("message", handler);
        resolve({ type: "decode-stream-error", error: "SW 响应超时" });
      }, 5000);
    });

    if (ready.type === "decode-stream-error")
      throw Error(ready.error || "准备失败");

    postViaIframe("/dl", { job: "dec", type: "stream", id: jobId });
  } catch (e) {
    toast("❌ " + (e.message || "提取失败"));
  }
  this.disabled = false;
  this.textContent = "⬇️";
}

// ── 批量下载 ──

async function batchDownload() {
  const indices = [];
  document
    .querySelectorAll(".dec-file-cb:checked")
    .forEach((cb) => indices.push(parseInt(cb.dataset.idx)));
  if (!indices.length) {
    toast("⚠️ 请选择文件");
    return;
  }
  this.disabled = true;
  this.textContent = "⏳ 准备中…";
  try {
    await waitForSw();
    let rawKey = null;
    if (decKey) rawKey = await crypto.subtle.exportKey("raw", decKey);
    const rawKeyArr = rawKey ? Array.from(new Uint8Array(rawKey)) : null;
    const chunkSize = parseInt(chunkSizeInput.value) || 64;

    const files = indices.map((idx) => ({
      offset: decEntries[idx].offset,
      size: decEntries[idx].size,
      nonce: decEntries[idx].nonceData
        ? Array.from(decEntries[idx].nonceData)
        : null,
      name: decEntries[idx].name,
    }));
    const gid = Date.now() + "";

    sendToSW({
      type: "decode-group",
      id: gid,
      files,
      bmpFile: decFile,
      keyRaw: rawKeyArr,
      chunkSize,
    });

    const groupReady = await new Promise((resolve) => {
      const handler = (e) => {
        const d = e.data;
        if (d.type === "decode-group-ready" && d.id === gid) {
          navigator.serviceWorker.removeEventListener("message", handler);
          resolve(d);
        }
        if (d.type === "decode-group-error" && d.id === gid) {
          navigator.serviceWorker.removeEventListener("message", handler);
          resolve(d);
        }
      };
      navigator.serviceWorker.addEventListener("message", handler);
      setTimeout(() => {
        navigator.serviceWorker.removeEventListener("message", handler);
        resolve(null);
      }, 5000);
    });

    if (!groupReady || groupReady.type === "decode-group-error") {
      throw Error(groupReady?.error || "分组准备失败");
    }

    for (let i = 0; i < files.length; i++) {
      postViaIframe("/dl", {
        job: "dec",
        type: "stream",
        id: gid,
        idx: i,
      });
    }
  } catch (e) {
    toast("❌ " + (e.message || "批量下载失败"));
  }
  this.disabled = false;
  this.textContent = "📥 下载选中";
}
