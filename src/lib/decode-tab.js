// ═══════════════════════════════════════════════
// 解码 Tab — 图片选择、元信息解析、提取下载
// ═══════════════════════════════════════════════
"use strict";

import { fmt } from "./f2p-core.js";
import {
  quickDetect,
  decodeContainer,
  readF2P6Header,
  decodeIndexSegment,
  verifyDataSegment,
  extractFileData,
} from "./f2p-decode.js";
import { $, toast, sendToSW, waitForSw, triggerDownload } from "./sw-client.js";
import { loadTemplate } from "./template.js";

// ── 解码状态 ──

let decSel = []; // [{ blob, name, size, detected }]
let dd = 0; // dragenter 计数

// 解码结果（由提取按钮填充）
let decResult = null;
// { type: "legacy", file, entries, key, bmpMeta, dataStart }
// { type: "f2p6",  entries, indexInfo, dataSegments }

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

// ── 文件选择（追加 + 去重）──

function addFs(fs) {
  const ex = new Set(decSel.map((f) => f.name + "|" + f.size));
  let added = 0;
  for (const f of fs) {
    const k = f.name + "|" + f.size;
    if (ex.has(k)) continue;
    decSel.push({ blob: f, name: f.name, size: f.size, detected: null });
    ex.add(k);
    added++;
  }
  if (added) {
    decSel.sort((a, b) => a.name.localeCompare(b.name));
    (async () => {
      for (const entry of decSel) {
        if (entry.detected !== null) continue;
        try {
          entry.detected = await quickDetect(entry.blob);
        } catch {}
      }
      updDecUI();
      // 单 BMP（非 F2P6）无需额外处理，legacyBlob 在 decBtn 中取 decSel[0]
    })();
    updDecUI();
    toast("📎 已添加 " + added + " 个");
  }
}

function rmF(i) {
  decSel.splice(i, 1);
  updDecUI();
}

// ── 渲染 BMP 选择列表 ──

function updDecUI() {
  if (decResult) return; // 已提取 → 保持提取结果列表

  if (!decSel.length) {
    decFileList.style.display = "none";
    decBtn.disabled = true;
    decText.textContent = "拖放图片，或点击选择";
    decHint.textContent = "通过文件头自动识别";
    decHint.classList.remove("err");
    return;
  }

  const total = decSel.length;
  const detectedCount = decSel.filter((e) => e.detected).length;
  const container = loadTemplate("enc-file-container");
  container.querySelector(".enc-file-summary").textContent =
    "共 " + total + " 个 BMP";

  const bodyEl = container.querySelector(".enc-file-body");
  for (let i = 0; i < decSel.length; i++) {
    const entry = decSel[i];
    const item = loadTemplate("enc-file-item");
    const div = item.querySelector(".file-item");
    div.dataset.idx = i;
    div.draggable = false; // 解码不排序
    item.querySelector(".idx").textContent = i;
    item.querySelector(".name").textContent = entry.detected
      ? entry.name + " · " + entry.detected
      : entry.name;
    item.querySelector(".size").textContent = fmt(entry.size);
    bodyEl.appendChild(item);
  }

  decFileList.innerHTML = "";
  decFileList.appendChild(container);
  decFileList.style.display = "block";

  // 删除按钮
  decFileList.querySelectorAll(".file-remove").forEach((b) => {
    b.addEventListener("click", function () {
      rmF(+this.closest(".file-item").dataset.idx);
    });
  });

  decBtn.disabled = false;

  // 更新 drop 区提示
  decText.textContent = total + " 个 BMP 已选择";
  decHint.textContent = detectedCount + "/" + total + " 个识别为 F2P 格式";
  decHint.classList.remove("err");
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
  const files = Array.from(e.dataTransfer.files);
  if (!files.length) {
    toast("⚠️ 请拖放文件");
    return;
  }
  if (decResult) {
    decResult = null;
    decSel = [];
    decFileList.style.display = "none";
  }
  addFs(files);
});

// ── 文件选择 ──

decInput.addEventListener("change", function () {
  const files = Array.from(this.files);
  this.value = "";
  if (!files.length) return;
  if (decResult) {
    decResult = null;
    decSel = [];
    decFileList.style.display = "none";
  }
  addFs(files);
});

decClearBtn.addEventListener("click", () => {
  decResult = null;
  decSel = [];
  decInput.value = "";
  decText.textContent = "拖放图片，或点击选择";
  decHint.textContent = "通过文件头自动识别";
  decHint.classList.remove("err");
  decBtn.disabled = true;
  decBtn.textContent = "🔎 提取";
  decFileList.style.display = "none";
});

// ── 提取按钮（解析元信息） ──

decBtn.addEventListener("click", async () => {
  const pwd = decPwdInput.value;

  // F2P6 模式：从 decSel 中找索引分卷
  if (decSel.some((e) => e.detected?.includes("F2P6"))) {
    if (!decSel.length) return;
    try {
      decBtn.disabled = true;
      decBtn.textContent = "⏳ 解码分卷…";

      const blobs = decSel.map((e) => e.blob);
      let indexBlob = null;
      const dataBlobs = [];
      for (const blob of blobs) {
        try {
          const hdr = await readF2P6Header(blob);
          if (hdr.segID === 0) indexBlob = blob;
          else dataBlobs.push({ segID: hdr.segID, blob });
        } catch {
          throw Error("不属于同一组分卷: " + (blob.name || ""));
        }
      }
      if (!indexBlob) throw Error("未找到索引分卷（segID=0）");

      const indexInfo = await decodeIndexSegment(
        indexBlob,
        pwd,
        parseInt(chunkSizeInput.value) || 64,
      );

      const dataSegments = [];
      if (indexInfo.segCount > 1) {
        for (const db of dataBlobs) {
          try {
            const info = await verifyDataSegment(
              db.blob,
              indexInfo.key,
              indexInfo.indexSalt,
            );
            dataSegments.push({ ...info, blob: db.blob });
          } catch {
            throw Error("不属于同一组分卷: " + (db.blob.name || ""));
          }
        }

        dataSegments.sort((a, b) => a.segID - b.segID);
        if (dataSegments.length < indexInfo.segCount - 1) {
          const missing = [];
          for (let i = 1; i < indexInfo.segCount; i++)
            if (!dataSegments.some((s) => s.segID === i)) missing.push(i);
          throw Error("缺少数据分卷: " + missing.join(", "));
        }
      }

      decResult = {
        type: "f2p6",
        entries: indexInfo.entries,
        indexInfo,
        dataSegments,
      };
      renderDecFiles(indexInfo.entries);
      decSel = [];
      updDecUI();
      toast("✅ F2P6 解码完成，共 " + indexInfo.entries.length + " 个文件");
    } catch (e) {
      toast("❌ " + (e.message || "解码失败"));
    } finally {
      decBtn.disabled = false;
      decBtn.textContent = "🔓 解码分卷";
    }
    return;
  }

  // ═══════════════════════════════════
  // 单 BMP 解码（F2P1-F2P5）
  // 前置条件：1 个非 F2P6 文件
  // ═══════════════════════════════════════
  const hasNonF2P6 = decSel.some(
    (e) => e.detected && !e.detected.includes("F2P6"),
  );
  if (!hasNonF2P6 || decSel.length !== 1) {
    if (hasNonF2P6 && decSel.length > 1)
      toast("⚠️ 混合了 F2P6 和非 F2P6 文件，无法解码");
    return;
  }
  const legacyBlob = decSel[0].blob;
  try {
    decBtn.disabled = true;
    decBtn.textContent = "⏳ 解析中…";

    const result = await decodeContainer(legacyBlob, pwd);
    decResult = {
      type: "legacy",
      file: legacyBlob,
      entries: result.entries,
      key: result.key,
      bmpMeta: result.meta || null,
      dataStart: result.dataStart || 0,
    };
    renderDecFiles(result.entries);
    decSel = [];
    updDecUI();
    toast("✅ 解码完成，共 " + result.entries.length + " 个文件");
  } catch (e) {
    toast("❌ " + (e.message || "解析失败"));
  } finally {
    decBtn.disabled = false;
    decBtn.textContent = "🔎 提取";
  }
});

// ── 渲染文件列表（提取结果） ──

function updateSelectionStats() {
  const cbs = decFileList.querySelectorAll(".dec-file-cb");
  let n = 0,
    s = 0;
  cbs.forEach((cb) => {
    if (cb.checked) {
      n++;
      s += decResult.entries[+cb.dataset.idx].size;
    }
  });
  const el = decFileList.querySelector(".dec-selected-count");
  if (el) el.textContent = "已选 " + n + " 个 · " + fmt(s);
  const allCb = decFileList.querySelector(".select-all-dec");
  if (allCb) allCb.checked = n === cbs.length;
}

function renderDecFiles(ent) {
  const totalSize = ent.reduce((s, f) => s + f.size, 0);

  const container = loadTemplate("dec-file-container");
  container.querySelector(".dec-file-summary").textContent =
    "共 " + ent.length + " 个 · " + fmt(totalSize);
  container.querySelector(".dec-selected-count").textContent =
    "已选 " + ent.length + " 个 · " + fmt(totalSize);

  const body = container.querySelector(".dec-file-body");
  for (let i = 0; i < ent.length; i++) {
    const f = ent[i];
    const item = loadTemplate("dec-file-item");
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

  decFileList
    .querySelectorAll(".dec-file-cb")
    .forEach((cb) => cb.addEventListener("change", updateSelectionStats));

  updateSelectionStats();

  decFileList
    .querySelector(".btn-batch-dl")
    .addEventListener("click", batchDownload);

  decFileList
    .querySelectorAll(".dl-btn")
    .forEach((a) => a.addEventListener("click", singleDownload));
}

// ── 通用：准备 F2P6 解码分组 ──

async function prepareF2P6Decode() {
  await waitForSw();
  const rawKey = await crypto.subtle.exportKey("raw", decResult.indexInfo.key);
  const gid = Date.now() + "";

  sendToSW({
    type: "f2p6-decode-group",
    id: gid,
    entries: decResult.indexInfo.entries,
    keyRaw: Array.from(new Uint8Array(rawKey)),
    indexBlob: decResult.indexInfo.bmpMeta.blob,
    indexSegSalt: Array.from(decResult.indexInfo.segSalt),
    dataInIndex: decResult.indexInfo.dataInIndex,
    indexDataPayloadOffset: decResult.indexInfo.indexDataPayloadOffset,
    dataSegments: decResult.dataSegments.map((s) => ({
      segID: s.segID,
      segSalt: Array.from(s.segSalt),
      dataSize: s.dataSize,
      dataOffset: s.dataOffset,
      blob: s.bmpMeta.blob,
    })),
    chunkSize: parseInt(chunkSizeInput.value) || 64,
  });

  return gid;
}

// ── 通用：导出密钥 raw ──

async function exportKeyRaw() {
  if (!decResult?.key) return null;
  const raw = await crypto.subtle.exportKey("raw", decResult.key);
  return Array.from(new Uint8Array(raw));
}

// ── 单文件下载 ──

async function singleDownload() {
  const idx = parseInt(this.dataset.idx);
  const ent = decResult.entries[idx];
  this.disabled = true;
  this.textContent = "⏳";
  try {
    if (decResult?.type === "f2p6") {
      const gid = await prepareF2P6Decode();
      triggerDownload("/files?id=" + gid + "&idx=" + idx);
    } else {
      await waitForSw();
      const chunkSize = parseInt(chunkSizeInput.value) || 64;
      const jobId = Date.now() + "";

      sendToSW({
        type: "decode-stream-prepare",
        jobId,
        bmpFile: decResult.file,
        offset: ent.offset,
        size: ent.size,
        counter: ent.counter ? Array.from(ent.counter) : null,
        bits: ent.bits || 0,
        name: ent.name,
        keyRaw: decResult.key
          ? Array.from(
              new Uint8Array(
                await crypto.subtle.exportKey("raw", decResult.key),
              ),
            )
          : null,
        chunkSize,
      });

      triggerDownload("/files?id=" + jobId);
    }
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
    if (decResult?.type === "f2p6") {
      const gid = await prepareF2P6Decode();
      for (const idx of indices) {
        triggerDownload("/files?id=" + gid + "&idx=" + idx);
      }
    } else {
      await waitForSw();
      const chunkSize = parseInt(chunkSizeInput.value) || 64;

      const files = indices.map((idx) => ({
        offset: decResult.entries[idx].offset,
        size: decResult.entries[idx].size,
        counter: decResult.entries[idx].counter
          ? Array.from(decResult.entries[idx].counter)
          : null,
        bits: decResult.entries[idx].bits || 0,
        name: decResult.entries[idx].name,
      }));
      const gid = Date.now() + "";

      sendToSW({
        type: "decode-group",
        id: gid,
        files,
        bmpFile: decResult.file,
        keyRaw: decResult.key
          ? Array.from(
              new Uint8Array(
                await crypto.subtle.exportKey("raw", decResult.key),
              ),
            )
          : null,
        chunkSize,
      });

      Promise.all(
        Array.from({ length: files.length }, (_, i) =>
          triggerDownload("/files?id=" + gid + "&idx=" + i),
        ),
      );
    }
  } catch (e) {
    toast("❌ " + (e.message || "批量下载失败"));
  }
  this.disabled = false;
  this.textContent = "📥 下载选中";
}
