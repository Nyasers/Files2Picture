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
const tasksList = $("tasksList");

function renderEmpty() {
  const tmpl = document.getElementById("tasks-empty").content.cloneNode(true);
  tasksList.innerHTML = "";
  tasksList.appendChild(tmpl);
}

export function refreshTasks() {
  sendToSW({ type: "list-jobs" });
}

onSWReady(refreshTasks);
onControllerChange(refreshTasks);

// ── 全量渲染（新增任务 / sync 时用）──

function renderTasks() {
  let entries = Array.from(jobHandlers.entries()).filter(
    ([, j]) => j.status === "running",
  );
  if (!entries.length) {
    renderEmpty();
    return;
  }

  entries.sort(([a], [b]) => b.localeCompare(a));

  const frag = document.createDocumentFragment();
  for (const [jobId, job] of entries) {
    const pct = job.progress || 0;
    const item = document.getElementById("task-item").content.cloneNode(true);
    const div = item.querySelector(".task-item");
    div.dataset.jobId = jobId;
    item.querySelector(".task-kind").textContent =
      job.kind === "encode" ? "🔒 编码" : "🔓 解码";
    if (job.label) {
      item.querySelector(".task-label").textContent = job.label;
    } else {
      item.querySelector(".task-label").remove();
    }
    if (job.currentFile) {
      item.querySelector(".task-file").textContent = job.currentFile;
    } else {
      item.querySelector(".task-file").remove();
    }
    item.querySelector(".tbar").style.width = pct + "%";
    item.querySelector(".task-pct").textContent = pct + "%";
    frag.appendChild(item);
  }
  tasksList.innerHTML = "";
  tasksList.appendChild(frag);
}

// ── 增量更新：只更新进度条和文件名 ──

function updateTaskProgress(jobId, progress, currentFile) {
  const item = document.querySelector(
    '.task-item[data-job-id="' + jobId + '"]',
  );
  if (!item) return;
  const bar = item.querySelector(".tbar");
  if (bar) bar.style.width = progress + "%";
  const pct = item.querySelector(".task-pct");
  if (pct) pct.textContent = progress + "%";
  if (currentFile) {
    const fileEl = item.querySelector(".task-file");
    if (fileEl) fileEl.textContent = currentFile;
  }
}

// ── 增量删除：移除已完成/错误/取消的任务 ──

function removeTaskItem(jobId) {
  const item = document.querySelector(
    '.task-item[data-job-id="' + jobId + '"]',
  );
  if (item) {
    item.remove();
    if (!document.querySelector(".task-item")) {
      renderEmpty();
    }
  }
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
  updateTaskProgress(msg.jobId, msg.progress, msg.currentFile);
}

function handleJobDone(msg) {
  const job = jobHandlers.get(msg.jobId);
  if (!job) return;
  sendToSW({ type: "consume", jobId: msg.jobId });
  jobHandlers.delete(msg.jobId);
  removeTaskItem(msg.jobId);
  if (!msg.jobId.includes("_")) {
    if (job.kind === "encode") toast("✅ 编码完成");
  }
}

function handleJobError(msg) {
  const job = jobHandlers.get(msg.jobId);
  if (!job) return;
  sendToSW({ type: "consume", jobId: msg.jobId });
  jobHandlers.delete(msg.jobId);
  removeTaskItem(msg.jobId);
  toast("❌ " + msg.error);
}

function handleJobUpdate(msg) {
  if (msg.status === "cancelled") {
    jobHandlers.delete(msg.jobId);
    removeTaskItem(msg.jobId);
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
