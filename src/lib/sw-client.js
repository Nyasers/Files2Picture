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

export function toast(m, d = 2500) {
  const e = document.createElement("div");
  e.className = "toast";
  e.textContent = m;
  tc.appendChild(e);
  setTimeout(() => {
    e.classList.add("out");
    setTimeout(() => e.remove(), 250);
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

// ── 表单 POST 触发流式下载 ──

export function postViaIframe(url, fields) {
  const id =
    "dlf_" + (Date.now() + "_" + Math.random().toString(36).slice(2, 8));
  const f = document.createElement("iframe");
  f.id = id;
  f.name = id;
  f.style.display = "none";
  document.body.appendChild(f);
  const form = document.createElement("form");
  form.method = "POST";
  form.action = url;
  form.target = id;
  form.style.display = "none";
  for (const [n, v] of Object.entries(fields)) {
    const el = document.createElement("input");
    el.type = "hidden";
    el.name = n;
    el.value = v;
    form.appendChild(el);
  }
  document.body.appendChild(form);
  form.submit();
  form.remove();
  // 等 SW 发来 download-started 信号再拆
  const jobId = fields.id + (fields.idx !== undefined ? "_" + fields.idx : "");
  const handler = (e) => {
    if (e.data.type === "download-started" && e.data.jobId === jobId) {
      navigator.serviceWorker.removeEventListener("message", handler);
      setTimeout(() => f.remove(), 0x0721);
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
