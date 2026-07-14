// ══════════════════════════════════════════════
// F2P Vue 入口
// ══════════════════════════════════════════════
"use strict";

// 浏览器兼容性检查
(function checkCompat() {
  try {
    if (typeof crypto?.subtle?.encrypt !== "function") throw 0;
    new Function("async function f(){var a;return a??=1}")();
  } catch (_) {
    document.body.innerHTML =
      '<div style="color:#e5554a;padding:2rem;text-align:center;line-height:1.6">' +
      '浏览器版本过低，请使用 Chrome 86+ / 现代浏览器</div>';
    throw Error("browser too old");
  }
})();

import { createApp } from "vue";
import "./style.css";
import App from "./App.vue";
import { initSW } from "./lib/sw-client.js";

initSW();

createApp(App).mount("#app");
