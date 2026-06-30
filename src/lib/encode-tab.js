// ═══════════════════════════════════════════════
// 编码 Tab — 文件选择、预计算、提交编码任务
// ═══════════════════════════════════════════════

import { fmt } from "./f2p-core.js";
import { precomputeBmp } from "./f2p-encode.js";
import { $, toast, sendToSW, waitForSw, postViaIframe } from "./sw-client.js";
import { switchTab } from "./ui-shell.js";

// ── 编码状态 ──

let sel = [];
let ed = 0; // dragenter 计数

// ── DOM ──

const encInput = $("encInput"),
  encDrop = $("encDrop"),
  fileList = $("fileList"),
  encBtn = $("encBtn"),
  clearBtn = $("clearBtn");
const encPwdInput = $("encPwdInput");
const chunkSizeInput = $("chunkSize");

// ── 文件选择 ──

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

function mvF(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= sel.length) return;
  [sel[i], sel[j]] = [sel[j], sel[i]];
  updUI();
}

function updUI() {
  if (!sel.length) {
    fileList.style.display = "none";
    encBtn.disabled = true;
    encBtn.textContent = "🎨 生成图片";
    return;
  }

  // 保存滚动位置
  const oldBody = document.getElementById("encFileBody");
  const scrollTop = oldBody ? oldBody.scrollTop : 0;

  const t = sel.reduce((s, f) => s + f.size, 0);
  let e =
    '<div class="enc-file-header"><span class="enc-file-summary">共 ' +
    sel.length +
    " 个文件 · " +
    fmt(t) +
    "</span></div>" +
    '<div class="enc-sort-header">' +
    "<span>#</span>" +
    "<span>文件名</span>" +
    "<span>大小</span>" +
    '<span class="enc-btn-col"></span>' +
    "</div>" +
    '<div class="enc-file-body" id="encFileBody">';
  for (let i = 0; i < sel.length; i++) {
    const n = sel[i];
    e +=
      '<div class="file-item" draggable="true" data-idx="' +
      i +
      '">' +
      '<span class="idx">' +
      i +
      "</span>" +
      '<span class="name">' +
      n.name +
      "</span>" +
      '<span class="size">' +
      fmt(n.size) +
      "</span>" +
      '<button class="file-remove" data-idx="' +
      i +
      '">✕</button>' +
      "</div>";
  }
  e += "</div>";
  fileList.innerHTML = e;
  fileList.style.display = "block";

  // 删除按钮
  fileList.querySelectorAll(".file-remove").forEach((b) => {
    b.addEventListener("click", function () {
      rmF(+this.dataset.idx);
    });
  });

  // 拖动排序
  const body = document.getElementById("encFileBody");
  let dragIdx = null;
  body.addEventListener("dragstart", (ev) => {
    const item = ev.target.closest(".file-item");
    if (!item) return;
    dragIdx = +item.dataset.idx;
    item.classList.add("dragging");
    ev.dataTransfer.effectAllowed = "move";
  });
  body.addEventListener("dragend", (ev) => {
    ev.target.closest(".file-item")?.classList.remove("dragging");
    body
      .querySelectorAll(".file-item")
      .forEach((el) => el.classList.remove("drag-over"));
    dragIdx = null;
  });
  body.addEventListener("dragover", (ev) => {
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";
    const target = ev.target.closest(".file-item");
    if (!target) return;
    const overIdx = +target.dataset.idx;
    if (overIdx === dragIdx) return;
    // 标记拖入位置
    body
      .querySelectorAll(".file-item")
      .forEach((el) => el.classList.remove("drag-over"));
    target.classList.add("drag-over");
  });
  body.addEventListener("dragleave", (ev) => {
    ev.target.closest(".file-item")?.classList.remove("drag-over");
  });
  body.addEventListener("drop", (ev) => {
    ev.preventDefault();
    const target = ev.target.closest(".file-item");
    if (!target || dragIdx === null) return;
    const dropIdx = +target.dataset.idx;
    if (dropIdx === dragIdx) return;
    const [item] = sel.splice(dragIdx, 1);
    sel.splice(dropIdx, 0, item);
    updUI();
  });

  encBtn.textContent =
    "🎨 生成图片（" + fmt(t) + " · " + sel.length + " 个文件）";
  encBtn.disabled = false;

  // 恢复滚动位置
  const newBody = document.getElementById("encFileBody");
  if (newBody) newBody.scrollTop = scrollTop;
}

encInput.addEventListener("change", function () {
  const f = Array.from(this.files);
  this.value = "";
  if (f.length) addFs(f);
});

clearBtn.addEventListener("click", () => {
  sel = [];
  updUI();
});

// ── 拖放 ──

encDrop.addEventListener("dragenter", (e) => {
  e.preventDefault();
  ed++;
  encDrop.classList.add("drag-over");
});
encDrop.addEventListener("dragover", (e) => e.preventDefault());
encDrop.addEventListener("dragleave", (e) => {
  ed--;
  if (ed <= 0) {
    ed = 0;
    encDrop.classList.remove("drag-over");
  }
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

// ── 提交编码任务 ──

encBtn.addEventListener("click", async () => {
  if (!sel.length) return;
  await waitForSw();
  const password = encPwdInput.value;
  const chunkSize = parseInt(chunkSizeInput.value) || 64;
  const files = sel.slice();
  const jobId = Date.now() + "";

  // 预计算 BMP 尺寸
  const pc = precomputeBmp(files.map((f) => ({ name: f.name, size: f.size })));
  const fn = "F2P_" + jobId + ".bmp";

  // 预注册编码流
  sendToSW({
    type: "encode-stream-prepare",
    jobId,
    filename: fn,
    size: pc.fs,
  });

  const ready = await new Promise((resolve) => {
    const handler = (e) => {
      const d = e.data;
      if (d.jobId === jobId && d.type === "encode-stream-ready") {
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

  if (!ready) {
    toast("⚠️ 编码流准备超时");
    return;
  }

  // 踢表单 POST /dl
  postViaIframe("/dl", { job: "enc", type: "stream", id: jobId });

  // 下发编码任务
  sendToSW({
    type: "encode",
    files,
    password,
    chunkSize,
    jobId,
    filename: fn,
  });

  sel = [];
  updUI();
  toast("📤 编码任务已提交");
  switchTab("tasks");
});
