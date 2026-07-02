// ═══════════════════════════════════════════════
// 解码 Tab — 图片选择、元信息解析、提取下载
// ═══════════════════════════════════════════════
"use strict";

import { fmt } from "./f2p-core.js";
import { quickDetect, decodeContainer } from "./f2p-decode.js";
import { $, toast, sendToSW, waitForSw, triggerDownload } from "./sw-client.js";

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
  decFileList.style.display = "none";
  decBtn.textContent = "🔎 提取";

  const detected = await quickDetect(decFile);
  if (detected) {
    decHint.classList.remove("err");
    decBtn.disabled = false;
    decHint.textContent = fmt(decFile.size) + " · " + detected;
  } else {
    decHint.classList.add("err");
    decBtn.disabled = true;
    decHint.textContent = fmt(decFile.size) + " · 非 F2P 文件";
  }
});

decClearBtn.addEventListener("click", () => {
  decFile = null;
  decEntries = null;
  decKey = null;
  decBmpMeta = null;
  decInput.value = "";
  decText.textContent = "拖放图片，或点击选择";
  decHint.textContent = "通过文件头自动识别";
  decHint.classList.remove("err");
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
  const cbs = decFileList.querySelectorAll(".dec-file-cb");
  let n = 0,
    s = 0;
  cbs.forEach((cb) => {
    if (cb.checked) {
      n++;
      s += decEntries[+cb.dataset.idx].size;
    }
  });
  const el = decFileList.querySelector(".dec-selected-count");
  if (el) el.textContent = "已选 " + n + " 个 · " + fmt(s);
  const allCb = decFileList.querySelector(".select-all-dec");
  if (allCb) allCb.checked = n === cbs.length;
}

function renderDecFiles(ent) {
  const totalSize = ent.reduce((s, f) => s + f.size, 0);

  // 用模板构建文件列表
  const container = document
    .getElementById("dec-file-container")
    .content.cloneNode(true);
  container.querySelector(".dec-file-summary").textContent =
    "共 " + ent.length + " 个 · " + fmt(totalSize);
  container.querySelector(".dec-selected-count").textContent =
    "已选 " + ent.length + " 个 · " + fmt(totalSize);

  const body = container.querySelector(".dec-file-body");
  for (let i = 0; i < ent.length; i++) {
    const f = ent[i];
    const item = document
      .getElementById("dec-file-item")
      .content.cloneNode(true);
    item.querySelector(".dec-file-cb").dataset.idx = i;
    item.querySelector(".name").textContent = "📄 " + f.name;
    item.querySelector(".size").textContent = fmt(f.size);
    item.querySelector(".dl-btn").dataset.idx = i;
    body.appendChild(item);
  }

  decFileList.innerHTML = "";
  decFileList.appendChild(container);
  decFileList.style.display = "block";
  decBtn.textContent = "✅ 已提取";

  decFileList
    .querySelector(".select-all-dec")
    .addEventListener("change", function () {
      decFileList
        .querySelectorAll(".dec-file-cb")
        .forEach((cb) => (cb.checked = this.checked));
      updateSelectionStats();
    });

  decFileList.querySelectorAll(".dec-file-cb").forEach((cb) => {
    cb.addEventListener("change", updateSelectionStats);
  });

  updateSelectionStats();

  decFileList
    .querySelector(".btn-batch-dl")
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
      counter: ent.counter ? Array.from(ent.counter) : null,
      bits: ent.bits || 0,
      name: ent.name,
      keyRaw: rawKey ? Array.from(new Uint8Array(rawKey)) : null,
      chunkSize: parseInt(chunkSizeInput.value) || 64,
    });

    // SW 同步设 pending 条目，GET /files?id=<jobId> 触发流式下载
    triggerDownload("/files?id=" + jobId);
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
      counter: decEntries[idx].counter
        ? Array.from(decEntries[idx].counter)
        : null,
      bits: decEntries[idx].bits || 0,
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

    // 全部并行触发，各 iframe 独立导航互不干扰
    Promise.all(
      Array.from({ length: files.length }, (_, i) =>
        triggerDownload("/files?id=" + gid + "&idx=" + i),
      ),
    );
  } catch (e) {
    toast("❌ " + (e.message || "批量下载失败"));
  }
  this.disabled = false;
  this.textContent = "📥 下载选中";
}
