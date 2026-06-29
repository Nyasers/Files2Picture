// ═══════════════════════════════════════════════
// UI 外壳 — Tab 切换 + 分片大小选择器
// ═══════════════════════════════════════════════

import { $ } from "./sw-client.js";

// ── Tab 切换 ──

export function switchTab(tab) {
  const tabs = ["enc", "dec", "tasks"];
  tabs.forEach((t) =>
    $(`tab${t[0].toUpperCase() + t.slice(1)}`).classList.remove("active"),
  );
  tabs.forEach((t) => ($(`${t}Section`).style.display = "none"));

  const tabMap = { enc: "Enc", dec: "Dec", tasks: "Tasks" };
  $(`tab${tabMap[tab]}`).classList.add("active");
  $(`${tab}Section`).style.display = "";
}

$("tabEnc").addEventListener("click", () => switchTab("enc"));
$("tabDec").addEventListener("click", () => switchTab("dec"));
$("tabTasks").addEventListener("click", () => switchTab("tasks"));

// ── 分片大小选择器 ──

const chunkSizeInput = $("chunkSize");
const memHint = $("memHint");

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
