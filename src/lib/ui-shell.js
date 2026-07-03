// ═══════════════════════════════════════════════
// UI 外壳 — Tab 切换 + 分片大小选择器
// ═══════════════════════════════════════════════
"use strict";

import { $ } from "./sw-client.js";

// ── Tab 切换 ──

function storeTab(tab) {
  try {
    sessionStorage.setItem("f2p.tab", tab);
  } catch {}
}

export function switchTab(tab) {
  const tabs = ["enc", "dec", "tasks"];
  tabs.forEach((t) =>
    $(`tab${t[0].toUpperCase() + t.slice(1)}`).classList.remove("active"),
  );
  tabs.forEach((t) => ($(`${t}Section`).style.display = "none"));

  const tabMap = { enc: "Enc", dec: "Dec", tasks: "Tasks" };
  $(`tab${tabMap[tab]}`).classList.add("active");
  $(`${tab}Section`).style.display = "";
  storeTab(tab);
}

$("tabEnc").addEventListener("click", () => switchTab("enc"));
$("tabDec").addEventListener("click", () => switchTab("dec"));
$("tabTasks").addEventListener("click", () => switchTab("tasks"));

// 恢复上次选中的分页（sessionStorage，多标签页互不干扰）
let restoreTab;
try {
  restoreTab = sessionStorage.getItem("f2p.tab");
} catch {}
if (restoreTab && ["enc", "dec", "tasks"].includes(restoreTab)) {
  switchTab(restoreTab);
}

// ── 安全 localStorage 封装 ──

function storageGet(key) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, val) {
  try {
    sessionStorage.setItem(key, val);
  } catch {}
}

function storageRemove(key) {
  try {
    sessionStorage.removeItem(key);
  } catch {}
}

// ── 分片大小预设 ──

const CHUNK_SIZES = [
  64, 256, 1024, 2048, 3072, 4096, 6144, 8192, 12288, 16384, 24576, 32768,
  49152, 65536, 98304, 131072, 196608, 262144, 393216, 524288, 786432, 1048576,
  1572864, 2097152, 3145728, 3932160,
];

function fmtChunkSize(kb) {
  return kb < 1024 ? `${kb} KB` : `${kb / 1024} MB`;
}

function populateChunkSizes() {
  const sel = $("chunkSize");
  CHUNK_SIZES.forEach((val) => {
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = fmtChunkSize(val);
    sel.appendChild(opt);
  });
}

populateChunkSizes();

// ── 分片大小选择器（值持久化到 localStorage）──

const STORAGE_KEY = "f2p.chunkSize";
const chunkSizeInput = $("chunkSize");
const memHint = $("memHint");

// 恢复上次选择，校验是否为合法选项
const saved = storageGet(STORAGE_KEY);
if (saved) {
  const isValid = Array.from(chunkSizeInput.options).some(
    (o) => o.value === saved,
  );
  if (isValid) chunkSizeInput.value = saved;
  else storageRemove(STORAGE_KEY);
}

function updateMemHint() {
  const kb = parseInt(chunkSizeInput.value, 10) || 64;
  const peak = kb * 8;
  let cls;
  if (peak < 262144) cls = "";
  else if (peak < 1048576) cls = "warn";
  else cls = "danger";
  memHint.textContent = "●";
  memHint.className = "mem-hint" + (cls ? " " + cls : "");
  memHint.title = cls ? "内存占用偏高" : "内存占用正常";
}

// 保存 + 即时反馈：change 保底，input 实时
chunkSizeInput.addEventListener("change", () => {
  storageSet(STORAGE_KEY, chunkSizeInput.value);
  updateMemHint();
});
chunkSizeInput.addEventListener("input", updateMemHint);

// 初始化时同步一次（localStorage 恢复后）
updateMemHint();

// ── 分卷大小选择器 ──

const bmpSizeSelect = $("targetBmpSize");
const bmpSizeHint = $("bmpSizeHint");

// 恢复上次选择
const savedBmp = storageGet("f2p.bmpSize");
if (savedBmp !== null) {
  const valid = Array.from(bmpSizeSelect.options).some(
    (o) => o.value === savedBmp,
  );
  if (valid) bmpSizeSelect.value = savedBmp;
}

bmpSizeSelect.addEventListener("change", () => {
  storageSet("f2p.bmpSize", bmpSizeSelect.value);
});

/**
 * 获取分卷大小（字节），0 = 不分卷
 */
export function getTargetBmpSize() {
  const mb = parseInt(bmpSizeSelect.value) || 0;
  return mb > 0 ? mb * 1048576 : 0;
}

/**
 * 设置分卷大小提示
 */
export function setBmpSizeHint(text, isWarning) {
  bmpSizeHint.textContent = text || "";
  bmpSizeHint.className = "bmp-size-hint" + (isWarning ? " warn" : "");
}
