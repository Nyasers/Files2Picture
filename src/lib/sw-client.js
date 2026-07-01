// ═══════════════════════════════════════════════
// SW 通信层 — Service Worker 生命周期 + 消息投递
// 所有 UI 模块通过此模块与 SW 交互
// ═══════════════════════════════════════════════

// ── 内部状态 ──

let swController = null;
const handlerMap = new Map(); // type -> Set<handler>
let swRegistration = null;
let statusTimer = null; // 延迟状态切换的定时器 id
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

// ── 状态栏 ──

const SW_COLORS = [
  "green",
  "red",
  "yellow",
  "blue",
  "orange",
  "purple",
  "gray",
];
const SW_COLOR_SET = new Set(SW_COLORS);

// 缓存 DOM 引用，避免重复查询
let _cachedDot = null;
let _cachedLabel = null;
let _cachedStatus = null;

function resolveDot() {
  return _cachedDot || (_cachedDot = $("swDot"));
}
function resolveLabel() {
  return _cachedLabel || (_cachedLabel = $("swLabel"));
}
function resolveStatus() {
  return _cachedStatus || (_cachedStatus = $("swStatus"));
}

export function getSWStatus() {
  const st = resolveStatus();
  if (!st) return "gray";
  for (const c of SW_COLORS) {
    if (st.classList.contains(c)) return c;
  }
  return "gray";
}

function setStatus(color, label) {
  if (!SW_COLOR_SET.has(color)) color = "gray";
  // 取消等待中的自动转绿，防止覆盖后续状态变更
  if (statusTimer) {
    clearTimeout(statusTimer);
    statusTimer = null;
  }
  const dot = resolveDot();
  const lbl = resolveLabel();
  const st = resolveStatus();
  if (st) {
    st.classList.remove(...SW_COLORS);
    st.classList.add(color);
  }
  if (dot) {
    dot.classList.remove(...SW_COLORS);
    dot.classList.add(color);
    dot.title = "Service Worker: " + label;
  }
  if (lbl) lbl.textContent = label;
}

// ── 初始化 ──

export function initSW() {
  if (!("serviceWorker" in navigator)) {
    setStatus("gray", "浏览器不支持");
    toast("⚠️ 当前浏览器不支持 Service Worker");
    return;
  }

  // 系统加载时已存在控制器 → 后续 controllerchange 是运行时更新
  // 不存在（首次访问） → 任何 controllerchange 都是首次激活，不加干扰
  const hadController = !!navigator.serviceWorker.controller;

  setStatus("yellow", "注册中");

  navigator.serviceWorker
    .register("sw.js")
    .then((registration) => {
      swRegistration = registration;
      // 检测新版本在 waiting
      if (registration.waiting) {
        setStatus("orange", "新版本可用");
      } else if (navigator.serviceWorker.controller) {
        setStatus("green", "已就绪");
      } else if (registration.installing) {
        setStatus("blue", "安装中");
      } else {
        setStatus("blue", "等待激活");
      }

      // 监听后续更新（页面已有控制器才算新版本）
      registration.addEventListener("updatefound", () => {
        const sw = registration.installing;
        if (!sw) return;
        if (navigator.serviceWorker.controller)
          setStatus("orange", "新版本可用");
        sw.addEventListener("statechange", () => {
          if (sw.state === "installed" && navigator.serviceWorker.controller) {
            setStatus("orange", "新版本已就绪");
          }
        });
      });
    })
    .catch((e) => {
      console.error("SW 注册失败", e);
      setStatus("red", "注册失败");
      toast("⚠️ Service Worker 注册失败");
    });

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    swController = navigator.serviceWorker.controller;
    if (hadController) {
      setStatus("purple", "更新中");
      statusTimer = setTimeout(() => setStatus("green", "已更新"), 600);
    }
    controllerChangeCallbacks.forEach((cb) => cb());
  });

  navigator.serviceWorker.ready.then(() => {
    swController = navigator.serviceWorker.controller;
    // 有等待中的新版本时不覆盖（保留橙色提示）
    if (!swRegistration || !swRegistration.waiting) {
      setStatus("green", "已就绪");
    }
    readyCallbacks.forEach((cb) => cb());
  });
}
