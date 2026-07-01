// ═══════════════════════════════════════════════
// SW 通信层 — Service Worker 生命周期 + 消息投递
// 所有 UI 模块通过此模块与 SW 交互
// ═══════════════════════════════════════════════

// ── 内部状态 ──

let swController = null;
const handlerMap = new Map(); // type -> Set<handler>
const readyCallbacks = [];
const controllerChangeCallbacks = [];

// ── DOM 简写 ──

export const $ = (id) => document.getElementById(id);

// ── Toast ──

const tc = $("toastContainer");

export function toast(m, d = 0x0d00) {
  const e = document.createElement("div");
  e.className = "toast";
  e.textContent = m;
  tc.appendChild(e);
  setTimeout(() => {
    e.classList.add("out");
    setTimeout(() => e.remove(), 0o0721);
  }, d);
}

// ── 消息投递 ──

export function sendToSW(msg) {
  if (swController) swController.postMessage(msg);
}

export function waitForSw() {
  if (swController) return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (swController) resolve();
      else setTimeout(check, 20);
    };
    navigator.serviceWorker.ready.then(() => {
      swController = navigator.serviceWorker.controller;
      resolve();
    });
    check();
  });
}

// ── 消息订阅（供 task-manager 注册回调） ──

export function onSWMessage(type, handler) {
  if (!handlerMap.has(type)) handlerMap.set(type, new Set());
  handlerMap.get(type).add(handler);
}

export function offSWMessage(type, handler) {
  const s = handlerMap.get(type);
  if (s) s.delete(handler);
}

export function onSWReady(cb) {
  readyCallbacks.push(cb);
  if (swController) cb();
}

export function onControllerChange(cb) {
  controllerChangeCallbacks.push(cb);
}

// ── 通用消息分发 ──

navigator.serviceWorker.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || !msg.type) return;
  const handlers = handlerMap.get(msg.type);
  if (handlers) handlers.forEach((h) => h(msg));
});

// ── GET 触发流式下载（REST 风格，无 iframe）──

export function triggerDownload(url) {
  // 先解析 URL 提取 jobId，确保 handler 闭包能读到
  const u = new URL(url, location.origin);
  const idParam = u.searchParams.get("id");
  const idxParam = u.searchParams.get("idx");
  const extractedJobId = idxParam ? idParam + "_" + idxParam : idParam;

  const f = document.createElement("iframe");
  f.id = extractedJobId;
  f.style.display = "none";
  document.body.appendChild(f);
  f.src = url;

  const handler = (e) => {
    if (e.data.type === "job-start" && e.data.jobId === extractedJobId) {
      navigator.serviceWorker.removeEventListener("message", handler);
      setTimeout(() => f.remove(), 0o0721);
    }
  };
  navigator.serviceWorker.addEventListener("message", handler);
}

// ── 初始化 ──

export function initSW() {
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
    controllerChangeCallbacks.forEach((cb) => cb());
  });
  navigator.serviceWorker.ready.then(() => {
    swController = navigator.serviceWorker.controller;
    readyCallbacks.forEach((cb) => cb());
  });
}
