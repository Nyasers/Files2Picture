// ═══════════════════════════════════════════════
// 编码 Tab — 文件选择、预计算、提交编码任务
// ═══════════════════════════════════════════════

import { fmt } from "./f2p-core.js";
import { $, toast, sendToSW, waitForSw, postViaIframe } from "./sw-client.js";
import { switchTab } from "./ui-shell.js";

// ── 编码状态 ──

let sel = [];
let nameEncEnabled = true;
let ed = 0; // dragenter 计数

// ── DOM ──

const encInput = $("encInput"),
  encDrop = $("encDrop"),
  fileList = $("fileList"),
  encBtn = $("encBtn"),
  clearBtn = $("clearBtn");
const encPwdInput = $("encPwdInput"),
  encNameBubble = $("encNameBubble");
const chunkSizeInput = $("chunkSize");

// ── 文件名加密开关 ──

encNameBubble.classList.add("on");
encNameBubble.addEventListener("click", () => {
  nameEncEnabled = !nameEncEnabled;
  encNameBubble.classList.toggle("on", nameEncEnabled);
  encNameBubble.innerHTML = nameEncEnabled ? "🔒 加密文件名" : "🔓 加密文件名";
});

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

function rmF(i) {
  sel.splice(i, 1);
  updUI();
}

function updUI() {
  if (!sel.length) {
    fileList.style.display = "none";
    encBtn.disabled = true;
    encBtn.textContent = "🎨 生成图片";
    return;
  }
  const t = sel.reduce((s, f) => s + f.size, 0);
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
  encBtn.textContent = "🎨 生成图片（~" + n + "×" + n + "）";
  encBtn.disabled = false;
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
  const nameEnc = nameEncEnabled;
  const chunkSize = parseInt(chunkSizeInput.value) || 64;
  const files = sel.slice();
  const jobId = Date.now() + "";

  // 预计算 BMP 总尺寸
  const flags = nameEnc ? 1 : 0;
  let ms = 33,
    ds = 0;
  for (const f of files) {
    const nl = new TextEncoder().encode(f.name).length;
    ms += 2 + nl + 8 + 12 + (flags ? 12 : 0);
    ds += f.size;
  }
  const ps = 8 + ms + ds;
  const sz = Math.max(4, Math.ceil(Math.sqrt(Math.ceil(ps / 3))));
  const st = sz * 3;
  const rp = (4 - (st % 4)) % 4;
  const rb = st + rp;
  const fs = 54 + rb * sz;
  const fn = "F2P_" + jobId + ".bmp";

  // 预注册编码流
  sendToSW({
    type: "encode-stream-prepare",
    jobId,
    filename: fn,
    size: fs,
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
    nameEnc,
    chunkSize,
    jobId,
    filename: fn,
  });

  sel = [];
  updUI();
  toast("📤 编码任务已提交");
  switchTab("tasks");
});
