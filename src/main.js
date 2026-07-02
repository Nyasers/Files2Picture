// ══════════════════════════════════════════════
// F2P 入口 — 模块导入 + SW 启动
// ══════════════════════════════════════════════
"use strict";

import "./style.css";
import { initSW } from "./lib/sw-client.js";

// 各模块在 import 时自动注册 DOM 事件和 SW 消息订阅
import "./lib/ui-shell.js";
import "./lib/task-manager.js";
import "./lib/encode-tab.js";
import "./lib/decode-tab.js";

// ═══ 首次访问：SW 预缓存后自动刷新 ═══

if (!navigator.serviceWorker.controller) {
  navigator.serviceWorker.addEventListener("message", function (e) {
    if (e.data?.type === "sw-ready") location.reload();
  });
  // 兜底：15s 仍未激活 → 提示 + 重试 initSW
  setTimeout(function () {
    if (!navigator.serviceWorker.controller) {
      var t = document.getElementById("toastContainer");
      if (t) {
        var e = document.createElement("div");
        e.className = "toast";
        e.textContent = "⚠️ Service Worker 激活超时，正在重试…";
        t.appendChild(e);
      }
      initSW();
      if (window.deloading) window.deloading();
    }
  }, 15000);
  initSW();
  return;
}

// ═══ 正常启动（SW 已就绪） ═══

initSW();

// 少女祈祷中 → 淡出
if (window.deloading) window.deloading();
