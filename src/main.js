// ══════════════════════════════════════════════
// F2P UI · 纯前端 · 通过 SW 执行编解码
// ══════════════════════════════════════════════

import "./style.css";
import {
  fmt,
  readBmpHeader,
  readPayload,
  decMetaStream,
  deriveEncKey,
  aesDecrypt,
} from "./lib/f2p-core.js";

// ── DOM ──

const $ = (id) => document.getElementById(id);

const tc = $("toastContainer");
const tabEnc = $("tabEnc"),
  tabDec = $("tabDec"),
  tabTasks = $("tabTasks"),
  encSection = $("encSection"),
  decSection = $("decSection"),
  tasksSection = $("tasksSection");
const chunkSizeInput = $("chunkSize"),
  memHint = $("memHint");

// 编码
const encInput = $("encInput"),
  encDrop = $("encDrop"),
  fileList = $("fileList"),
  encBtn = $("encBtn"),
  clearBtn = $("clearBtn");
const encPwdInput = $("encPwdInput"),
  encNameEncCb = $("encNameEncCb");

// 解码
const decInput = $("decInput"),
  decDrop = $("decDrop"),
  decText = $("decText"),
  decHint = $("decHint"),
  decBtn = $("decBtn"),
  decClearBtn = $("decClearBtn"),
  decPwdInput = $("decPwdInput"),
  decFileList = $("decFileList");

// 任务
const tasksList = $("tasksList");

// ── Tab ──

function switchTab(tab) {
  [tabEnc, tabDec, tabTasks].forEach((t) => t.classList.remove("active"));
  [encSection, decSection, tasksSection].forEach(
    (s) => (s.style.display = "none"),
  );
  if (tab === "enc") {
    tabEnc.classList.add("active");
    encSection.style.display = "";
  } else if (tab === "dec") {
    tabDec.classList.add("active");
    decSection.style.display = "";
  } else {
    tabTasks.classList.add("active");
    tasksSection.style.display = "";
    refreshTasks();
  }
}
tabEnc.addEventListener("click", () => switchTab("enc"));
tabDec.addEventListener("click", () => switchTab("dec"));
tabTasks.addEventListener("click", () => switchTab("tasks"));

// ── Toast ──

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

// ── 分片大小提示 ──

function updateMemHint() {
  const kb = parseInt(chunkSizeInput.value) || 64;
  const peak = kb * 8;
  let cls;
  if (peak < 262144) cls = "";
  else if (peak < 1048576) cls = "warn";
  else cls = "danger";
  memHint.textContent = "●";
  memHint.className = "mem-hint" + (cls ? " " + cls : "");
  memHint.title = cls ? "内存占用偏高" : "内存占用正常";
}
chunkSizeInput.addEventListener("change", updateMemHint);
updateMemHint();

// ── SW 通信 ──

let swController = null;
const jobHandlers = new Map();

function sendToSW(msg) {
  if (swController) swController.postMessage(msg);
}

function initSW() {
  if (!("serviceWorker" in navigator)) {
    toast("⚠️ 当前浏览器不支持 Service Worker");
    return;
  }
  navigator.serviceWorker.register("sw.js").catch((e) => {
    console.error("SW 注册失败", e);
    toast("⚠️ Service Worker 注册失败");
  });
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    swController = navigator.serviceWorker.controller;
    refreshTasks();
  });
  navigator.serviceWorker.ready.then(() => {
    swController = navigator.serviceWorker.controller;
    refreshTasks();
  });
}

navigator.serviceWorker.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || !msg.type) return;
  switch (msg.type) {
    case "job-new":
      handleJobNew(msg);
      break;
    case "job-progress":
      handleJobProgress(msg);
      break;
    case "job-done":
      handleJobDone(msg);
      break;
    case "job-error":
      handleJobError(msg);
      break;
    case "job-update":
      handleJobUpdate(msg);
      break;
    case "jobs-list":
      for (const j of msg.jobs) handleJobSync(j);
      break;
    case "job-data":
      handleJobData(msg);
      break;
  }
});

// ── 文件选择（编码） ──

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

// ── 提交编码任务 ──

encBtn.addEventListener("click", () => {
  if (!sel.length) return;
  const password = encPwdInput.value;
  const nameEnc = encNameEncCb.checked;
  const chunkSize = parseInt(chunkSizeInput.value) || 64;
  const files = sel.slice();
  const jobId = "e" + Date.now();

  // 页面预计算 BMP 总尺寸，带上 Content-Length
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
  const fn =
    "F2P_" +
    new Date().toISOString().replace(/[:.]/g, "").slice(0, 15) +
    ".bmp";

  // 先踢一脚流式下载（iframe 避免页面导航）
  const ifr = document.createElement("iframe");
  ifr.style.display = "none";
  ifr.src =
    "/f2p-dl-stream/" +
    jobId +
    "?size=" +
    fs +
    "&name=" +
    encodeURIComponent(fn);
  document.body.appendChild(ifr);

  // 再下发任务
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

// ── 文件选择（解码） ──

let decFile = null,
  decEntries = null,
  decKey = null,
  decBmpMeta = null,
  decDataStart = 0,
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
  } else toast("⚠️ 请拖放文件");
});
decInput.addEventListener("change", async function () {
  if (this.files.length) {
    decFile = this.files[0];
    decEntries = null;
    decKey = null;
    decBmpMeta = null;
    decText.textContent = decFile.name;
    decHint.textContent = fmt(decFile.size) + " · BMP";
    decBtn.disabled = !1;
    decFileList.style.display = "none";
    decBtn.textContent = "🔎 提取";
    const info = await quickDetect(decFile);
    if (info) decHint.textContent += " · " + info;
  } else {
    decFile = null;
    decEntries = null;
    decKey = null;
    decBmpMeta = null;
    decText.textContent = "拖放图片，或点击选择";
    decHint.textContent = "通过文件头自动识别";
    decBtn.disabled = !0;
  }
});

async function quickDetect(file) {
  try {
    const m = await readBmpHeader(file);
    const hdr = await readPayload(m, 0, 8);
    const marker = (hdr[0] << 24) | (hdr[1] << 16) | (hdr[2] << 8) | hdr[3];
    if (marker === 0x46325032) return "F2P2";
    if (marker === 0x46325031) return "F2P1";
    if ((hdr[0] << 8) | (hdr[1] > 0)) return "旧格式";
    return "未知格式";
  } catch {
    return null;
  }
}

decClearBtn.addEventListener("click", () => {
  decFile = null;
  decEntries = null;
  decKey = null;
  decBmpMeta = null;
  decInput.value = "";
  decText.textContent = "拖放图片，或点击选择";
  decHint.textContent = "通过文件头自动识别";
  decBtn.disabled = !0;
  decFileList.style.display = "none";
});

// ── 页面解析元信息，显示文件列表 ──

decBtn.addEventListener("click", async () => {
  if (!decFile) return;
  const pwd = decPwdInput.value;
  try {
    decBtn.disabled = !0;
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
  } catch (e) {
    toast("❌ " + (e.message || "解析失败"));
    decBtn.disabled = !1;
    decBtn.textContent = "🔎 提取";
  }
});

function renderDecFiles(ent) {
  let h =
    '<div style="font-size:0.8rem;color:#888;margin-bottom:6px">共 ' +
    ent.length +
    " 个文件</div>";
  for (let i = 0; i < ent.length; i++) {
    const f = ent[i];
    const jobId = "d" + Date.now() + "_" + i;
    h +=
      '<div class="decode-file-item"><span class="name">📄 ' +
      f.name +
      '</span><span class="size">' +
      fmt(f.size) +
      '</span><button class="dl-btn" data-idx="' +
      i +
      '" data-job="' +
      jobId +
      '">⬇️</button></div>';
  }
  decFileList.innerHTML = h;
  decFileList.style.display = "block";
  decBtn.textContent = "✅ 已提取";

  // 点下载按钮时在页面直接提取 + 下载
  decFileList.querySelectorAll(".dl-btn").forEach((a) => {
    a.addEventListener("click", async function () {
      const idx = parseInt(this.dataset.idx);
      const ent = decEntries[idx];
      this.disabled = true;
      this.textContent = "⏳";
      try {
        const jobId = "d" + Date.now();
        let rawKey = null;
        if (decKey) rawKey = await crypto.subtle.exportKey("raw", decKey);
        const fd = new FormData();
        fd.append("bmp", decFile);
        if (rawKey) fd.append("key", new Blob([rawKey]));
        fd.append("offset", decDataStart);
        fd.append("size", ent.size);
        fd.append("nonce", new Blob([ent.nonceData]));
        fd.append("name", ent.name);

        const resp = await fetch("/f2p-dl/" + jobId, {
          method: "POST",
          body: fd,
        });
        if (!resp.ok) throw Error("服务错误");
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const dl = document.createElement("a");
        dl.href = url;
        dl.download = ent.name;
        dl.click();
        URL.revokeObjectURL(url);
        toast("⬇️ " + ent.name);
      } catch (e) {
        toast("❌ " + (e.message || "提取失败"));
      }
      this.disabled = false;
      this.textContent = "⬇️";
    });
  });
}

// ── 任务管理 ──

function renderTasks() {
  const entries = Array.from(jobHandlers.entries());
  if (!entries.length) {
    tasksList.innerHTML =
      '<div style="text-align:center;color:#666;padding:20px">暂无任务</div>';
    return;
  }
  let h = "";
  for (const [jobId, job] of entries) {
    const isRunning = job.status === "running";
    const isDone = job.status === "done";
    const isError = job.status === "error";
    const isCancelled = job.status === "cancelled";
    const pct = job.progress || 0;

    h += '<div class="task-item">';
    h +=
      '<div class="task-header"><span class="task-kind">' +
      (job.kind === "encode" ? "🔒 编码" : "🔓 解码") +
      "</span>" +
      '<span class="task-status ' +
      (isDone ? "ok" : isError ? "err" : isCancelled ? "err" : "") +
      '">' +
      (isRunning ? "运行中…" : isDone ? "完成" : isError ? "失败" : "已取消") +
      "</span></div>";

    if (job.label) h += '<div class="task-label">' + job.label + "</div>";
    if (job.currentFile)
      h += '<div class="task-file">' + job.currentFile + "</div>";

    if (isRunning && job.kind === "encode") {
      h +=
        '<div class="tbar-wrap"><div class="tbar" style="width:' +
        pct +
        '%"></div></div>';
      h +=
        '<div class="task-pct">' +
        pct +
        '%</div><button class="btn-cancel" data-job="' +
        jobId +
        '">取消</button>';
    }

    if (isDone && job.kind === "encode") {
      h +=
        '<div class="task-actions"><span style="color:#5aff8a;font-size:0.85rem">✅ 已保存</span>' +
        '<button class="btn-clear" data-job="' +
        jobId +
        '">✕</button></div>';
    }

    if (isDone && job.kind === "decode" && job.decodedFiles) {
      h += '<div class="task-files">';
      for (let i = 0; i < job.decodedFiles.length; i++) {
        const f = job.decodedFiles[i];
        h +=
          '<div class="task-file-item"><span>' +
          f.name +
          "</span><span>" +
          fmt(f.size) +
          '</span><a href="/f2p-dl/' +
          jobId +
          "/" +
          i +
          '" class="btn-dl-sm" download>⬇️</a></div>';
      }
      h += "</div>";
      h += '<button class="btn-clear" data-job="' + jobId + '">✕ 清除</button>';
    }

    if (isError) {
      h += '<div class="task-error">❌ ' + (job.error || "") + "</div>";
      h += '<button class="btn-clear" data-job="' + jobId + '">✕ 清除</button>';
    }
    if (isCancelled) {
      h += '<button class="btn-clear" data-job="' + jobId + '">✕ 清除</button>';
    }

    h += "</div>";
  }
  tasksList.innerHTML = h;

  // 事件绑定
  tasksList.querySelectorAll(".btn-cancel").forEach((b) => {
    b.addEventListener("click", function () {
      sendToSW({ type: "cancel", jobId: this.dataset.job });
    });
  });
  tasksList.querySelectorAll(".btn-clear").forEach((b) => {
    b.addEventListener("click", function () {
      sendToSW({ type: "consume", jobId: this.dataset.job });
      jobHandlers.delete(this.dataset.job);
      renderTasks();
    });
  });
}

function refreshTasks() {
  sendToSW({ type: "list-jobs" });
}

// ── 任务回调 ──

function handleJobNew(msg) {
  jobHandlers.set(msg.jobId, {
    jobId: msg.jobId,
    kind: msg.kind,
    status: "running",
    progress: 0,
    label: msg.label,
    totalFiles: msg.totalFiles,
    currentFile: "",
  });
  renderTasks();
}

function handleJobProgress(msg) {
  const job = jobHandlers.get(msg.jobId);
  if (!job) return;
  job.progress = msg.progress;
  if (msg.currentFile) job.currentFile = msg.currentFile;
  renderTasks();
}

function handleJobDone(msg) {
  const job = jobHandlers.get(msg.jobId);
  if (!job) return;
  job.status = "done";
  job.progress = 100;
  job.filename = msg.filename;
  job.size = msg.size;
  if (msg.kind === "decode" && msg.files) {
    job.decodedFiles = msg.files;
  }
  renderTasks();
  toast("✅ " + (job.kind === "encode" ? "编码" : "解码") + "完成");
}

function handleJobError(msg) {
  const job = jobHandlers.get(msg.jobId);
  if (!job) return;
  job.status = "error";
  job.error = msg.error;
  renderTasks();
  toast("❌ " + msg.error);
}

function handleJobUpdate(msg) {
  const job = jobHandlers.get(msg.jobId);
  if (!job) return;
  job.status = msg.status;
  renderTasks();
}

function handleJobSync(j) {
  const job = jobHandlers.get(j.jobId);
  if (job) {
    Object.assign(job, j);
  } else {
    jobHandlers.set(j.jobId, { ...j });
  }
  renderTasks();
}

function handleJobData(msg) {
  // 编码完成，从 SW 收到结果数据，创建 blob 下载
  const blob = new Blob([msg.data], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = msg.fileName;
  a.click();
  URL.revokeObjectURL(url);
}

// ── 启动 ──

initSW();
