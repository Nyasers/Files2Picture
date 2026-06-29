// ═══════════════════════════════════════════════
// 任务管理 — 任务列表渲染 + Job 状态回调
// ═══════════════════════════════════════════════

import {
  $,
  sendToSW,
  toast,
  onSWMessage,
  onSWReady,
  onControllerChange,
} from "./sw-client.js";

// ── Job 状态存储 ──

const jobHandlers = new Map();

export function refreshTasks() {
  sendToSW({ type: "list-jobs" });
}

onSWReady(refreshTasks);
onControllerChange(refreshTasks);

// ── 渲染 ──

function renderTasks() {
  let entries = Array.from(jobHandlers.entries()).filter(
    ([, j]) => j.status === "running",
  );
  if (!entries.length) {
    $("tasksList").innerHTML =
      '<div style="text-align:center;color:#666;padding:20px">暂无任务</div>';
    return;
  }

  entries.sort(([a], [b]) => b.localeCompare(a));

  let h = "";
  for (const [jobId, job] of entries) {
    const pct = job.progress || 0;
    h += '<div class="task-item">';
    h +=
      '<div class="task-header"><span class="task-kind">' +
      (job.kind === "encode" ? "🔒 编码" : "🔓 解码") +
      '</span><span class="task-status">运行中…</span></div>';
    if (job.label) h += '<div class="task-label">' + job.label + "</div>";
    if (job.currentFile)
      h += '<div class="task-file">' + job.currentFile + "</div>";
    h +=
      '<div class="tbar-wrap"><div class="tbar" style="width:' +
      pct +
      '%"></div></div>' +
      '<div class="task-pct">' +
      pct +
      "%</div>";
    h += "</div>";
  }
  $("tasksList").innerHTML = h;
}

// ── 回调 ──

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
  sendToSW({ type: "consume", jobId: msg.jobId });
  jobHandlers.delete(msg.jobId);
  renderTasks();
  if (!msg.jobId.includes("_")) {
    if (job.kind === "encode") toast("✅ 编码完成");
  }
}

function handleJobError(msg) {
  const job = jobHandlers.get(msg.jobId);
  if (!job) return;
  sendToSW({ type: "consume", jobId: msg.jobId });
  jobHandlers.delete(msg.jobId);
  renderTasks();
  toast("❌ " + msg.error);
}

function handleJobUpdate(msg) {
  if (msg.status === "cancelled") {
    jobHandlers.delete(msg.jobId);
    renderTasks();
  }
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

// ── 注册消息处理 ──

onSWMessage("job-new", handleJobNew);
onSWMessage("job-progress", handleJobProgress);
onSWMessage("job-done", handleJobDone);
onSWMessage("job-error", handleJobError);
onSWMessage("job-update", handleJobUpdate);
onSWMessage("jobs-list", (msg) => {
  for (const j of msg.jobs) handleJobSync(j);
});
