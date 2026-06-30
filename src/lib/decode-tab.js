// ═══════════════════════════════════════════════
// 解码 Tab — 图片选择、元信息解析、提取下载
// ═══════════════════════════════════════════════

import { fmt } from "./f2p-core.js";
import { quickDetect, decodeContainer } from "./f2p-decode.js";
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
  if (!this.files.length) return;
  decFile = this.files[0];
  decEntries = null;
  decKey = null;
  decBmpMeta = null;
  decText.textContent = decFile.name;
  decBtn.disabled = false;
  decFileList.style.display = "none";
  decBtn.textContent = "🔎 提取";
  const info = await quickDetect(decFile);
  if (info) decHint.textContent = fmt(decFile.size) + " · " + info;
  else decHint.textContent = fmt(decFile.size);
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

    const result = await decodeContainer(decFile, pwd);
    decEntries = result.entries;
    decKey = result.key;
    decBmpMeta = result.meta || null;
    decDataStart = result.dataStart || 0;
    renderDecFiles(result.entries);

    toast("✅ 解码完成，共 " + decEntries.length + " 个文件");
  } catch (e) {
    toast("❌ " + (e.message || "解析失败"));
  } finally {
    decBtn.disabled = false;
    decBtn.textContent = "🔎 提取";
  }
});

// ── 渲染文件列表 ──
// 以下保持不变

function updateSelectionStats() {
  const cbs = document.querySelectorAll(".dec-file-cb");
  let n = 0,
    s = 0;
  cbs.forEach((cb) => {
    if (cb.checked) {
      n++;
      s += decEntries[+cb.dataset.idx].size;
    }
  });
  const el = document.getElementById("decSelectedCount");
  if (el) el.textContent = "已选 " + n + " 个 · " + fmt(s);
  const allCb = document.getElementById("selectAllDec");
  if (allCb) allCb.checked = n === cbs.length;
}

function renderDecFiles(ent) {
  const totalSize = ent.reduce((s, f) => s + f.size, 0);
  let h =
    '<div class="dec-file-header"><label class="select-all-label"><input type="checkbox" id="selectAllDec" checked> 全选</label>' +
    '<span class="dec-file-summary" id="decSummary">共 ' +
    ent.length +
    " 个 · " +
    fmt(totalSize) +
    '</span><span class="dec-selected-count" id="decSelectedCount">已选 ' +
    ent.length +
    " 个 · " +
    fmt(totalSize) +
    "</span>" +
    '<button class="btn-batch-dl" id="batchDlBtn">📥 下载选中</button></div>' +
    '<div class="dec-file-body">';
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

  document
    .getElementById("selectAllDec")
    .addEventListener("change", function () {
      document
        .querySelectorAll(".dec-file-cb")
        .forEach((cb) => (cb.checked = this.checked));
      updateSelectionStats();
    });

  document.querySelectorAll(".dec-file-cb").forEach((cb) => {
    cb.addEventListener("change", updateSelectionStats);
  });

  updateSelectionStats();

  document
    .getElementById("batchDlBtn")
    .addEventListener("click", batchDownload);

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
