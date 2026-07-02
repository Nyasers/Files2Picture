// ═══════════════════════════════════════════════
// 任务管理 — 任务列表渲染 + Job 状态回调
// ═══════════════════════════════════════════════
"use strict";

import {
  $,
  sendToSW,
  toast,
  onSWMessage,
  onSWReady,
  onControllerChange,
} from "./sw-client.js";
import { loadTemplate } from "./template.js";

// ── Job 状态存储 ──

const jobHandlers = new Map();
const taskHistory = []; // 保留最近 50 条历史
const tasksList = $("tasksList");

function renderEmpty() {
  tasksList.innerHTML = "";
  tasksList.appendChild(loadTemplate("tasks-empty"));
}

export function refreshTasks() {
  sendToSW({ type: "list-jobs" });
}

onSWReady(refreshTasks);
onControllerChange(refreshTasks);

// ── 全量渲染（新增任务 / sync 时用）──

function renderTasks() {
  // 展示 running 任务 + 最近历史
  const running = Array.from(jobHandlers.entries()).filter(
    ([, j]) => j.status === "running",
  );
  const items = [];

  for (const [jobId, job] of running) {
    items.push({ jobId, job, isHistory: false });
  }
  for (const h of taskHistory) {
    items.push({ jobId: h.jobId, job: h, isHistory: true });
  }

  if (!items.length) {
    renderEmpty();
    return;
  }

  // running 按 jobId 倒序（新任务在前），history 保持插入顺序（unshift 已倒序）
  items.sort((a, b) => {
    if (a.isHistory !== b.isHistory) return a.isHistory ? 1 : -1;
    if (!a.isHistory) return (b.jobId || "").localeCompare(a.jobId || "");
    return 0; // history 保持 taskHistory 的插入顺序
  });

  const frag = document.createDocumentFragment();
  for (const { jobId, job, isHistory } of items) {
    const pct = job.progress || 0;
    const item = loadTemplate("task-item");
    const div = item.querySelector(".task-item");
    div.dataset.jobId = jobId;
    item.querySelector(".task-kind").textContent =
      job.kind === "encode" ? "🔒 编码" : "🔓 解码";

    if (isHistory) div.classList.add("history");

    if (job.label) {
      item.querySelector(".task-label").textContent = job.label;
    } else {
      item.querySelector(".task-label").remove();
    }
    const fileEl = item.querySelector(".task-file");
    if (fileEl) {
      if (job.currentFile) {
        fileEl.textContent = job.currentFile;
        fileEl.style.display = "";
      } else {
        fileEl.style.display = "none";
      }
    }

    const statusEl = item.querySelector(".task-status");
    if (!statusEl) {
      // 模板变化时安全跳过
    } else if (!isHistory) {
      statusEl.textContent = "运行中…";
      statusEl.classList.remove("ok", "err");
    } else if (job.status === "done") {
      statusEl.textContent = "✅ 完成";
      statusEl.classList.remove("err");
      statusEl.classList.add("ok");
    } else if (job.status === "error") {
      statusEl.textContent = "❌ " + (job.error || "失败");
      statusEl.classList.remove("ok");
      statusEl.classList.add("err");
    } else if (job.status === "cancelled") {
      statusEl.textContent = "⛔ 已取消";
      statusEl.classList.remove("ok");
      statusEl.classList.add("err");
    }

    const bar = item.querySelector(".tbar");
    if (bar) {
      bar.style.width = (isHistory && job.status === "done" ? 100 : pct) + "%";
    }
    const pctEl = item.querySelector(".task-pct");
    if (pctEl) {
      pctEl.textContent =
        (isHistory && job.status === "done" ? 100 : pct) + "%";
    }

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
  const fileEl = item.querySelector(".task-file");
  if (fileEl) {
    if (currentFile) {
      fileEl.textContent = currentFile;
      fileEl.style.display = "";
    } else {
      fileEl.style.display = "none";
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
  // 移入历史
  job.status = "done";
  job.progress = 100;
  jobHandlers.delete(msg.jobId);
  taskHistory.unshift({
    jobId: msg.jobId,
    kind: job.kind,
    status: "done",
    progress: 100,
    label: job.label
      ? job.label.replace("编码中", "编码完成")
      : job.kind === "encode"
        ? "编码完成"
        : "解码完成",
    currentFile: "",
    error: null,
  });
  if (taskHistory.length > 50) taskHistory.length = 50;
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
  taskHistory.unshift({
    jobId: msg.jobId,
    kind: job.kind,
    status: "error",
    progress: job.progress || 0,
    label: job.label || "",
    currentFile: job.currentFile || "",
    error: msg.error,
  });
  if (taskHistory.length > 50) taskHistory.length = 50;
  renderTasks();
  toast("❌ " + msg.error);
}

function handleJobUpdate(msg) {
  if (msg.status === "cancelled") {
    const job = jobHandlers.get(msg.jobId);
    if (job) {
      jobHandlers.delete(msg.jobId);
      taskHistory.unshift({
        jobId: msg.jobId,
        kind: job.kind,
        status: "cancelled",
        progress: job.progress || 0,
        label: job.label || "",
        currentFile: job.currentFile || "",
        error: null,
      });
      if (taskHistory.length > 50) taskHistory.length = 50;
    }
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
