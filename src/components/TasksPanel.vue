<template>
  <div class="panel">
    <div class="card">
      <div class="card-header">
        <h2>任务列表</h2>
      </div>

      <div v-if="!items.length" class="empty-state">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.3">
          <path d="M9 11l3 3L22 4"/>
          <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
        </svg>
        <span>暂无任务</span>
      </div>

      <div v-for="(item, i) in items" :key="item.id" class="task-item" :class="{ history: item.isHistory }">
        <div class="task-header">
          <span class="task-kind">{{ item.job.kind === 'encode' ? '编码' : '解码' }}</span>
          <span class="task-status" :class="statusClass(item)">{{ statusText(item) }}</span>
        </div>
        <div v-if="item.job.label" class="task-label">{{ item.job.label }}</div>
        <div v-if="item.job.currentFile" class="task-file">{{ item.job.currentFile }}</div>
        <div class="task-progress">
          <div class="tbar-wrap">
            <div class="tbar" :style="{ width: progressPct(item) + '%' }"></div>
          </div>
          <span class="task-pct">{{ progressPct(item) }}%</span>
        </div>
        <div v-if="item.job.error" class="task-error">{{ item.job.error }}</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from "vue";
import {
  sendToSW, onSWMessage, onSWReady, onControllerChange
} from "../lib/sw-client.js";

// 任务状态
const running = new Map();
const history = ref([]);

const items = computed(() => {
  const result = [];
  for (const [jobId, job] of running) {
    result.push({ id: jobId, job, isHistory: false });
  }
  for (const h of history.value) {
    result.push({ id: h.jobId, job: h, isHistory: true });
  }
  return result;
});

function statusClass(item) {
  if (!item.isHistory) return "";
  if (item.job.status === "done") return "ok";
  if (item.job.status === "error" || item.job.status === "cancelled") return "err";
  return "";
}

function statusText(item) {
  if (!item.isHistory) return "运行中...";
  if (item.job.status === "done") return "完成";
  if (item.job.status === "error") return "失败: " + (item.job.error || "");
  if (item.job.status === "cancelled") return "已取消";
  return "";
}

function progressPct(item) {
  if (item.isHistory && item.job.status === "done") return 100;
  return item.job.progress || 0;
}

// 消息处理器
function handleJobNew(msg) {
  running.set(msg.jobId, {
    jobId: msg.jobId, kind: msg.kind, status: "running",
    progress: 0, label: msg.label, totalFiles: msg.totalFiles,
    currentFile: "",
  });
}

function handleJobProgress(msg) {
  const job = running.get(msg.jobId);
  if (!job) return;
  job.progress = msg.progress;
  if (msg.currentFile) job.currentFile = msg.currentFile;
}

function handleJobDone(msg) {
  const job = running.get(msg.jobId);
  if (!job) return;
  sendToSW({ type: "consume", jobId: msg.jobId });
  running.delete(msg.jobId);
  history.value.unshift({
    jobId: msg.jobId, kind: job.kind, status: "done",
    progress: 100,
    label: job.label ? job.label.replace("编码中", "编码完成") : (job.kind === "encode" ? "编码完成" : "解码完成"),
    currentFile: "", error: null,
  });
  if (history.value.length > 50) history.value.length = 50;
}

function handleJobError(msg) {
  const job = running.get(msg.jobId);
  if (!job) return;
  sendToSW({ type: "consume", jobId: msg.jobId });
  running.delete(msg.jobId);
  history.value.unshift({
    jobId: msg.jobId, kind: job.kind, status: "error",
    progress: job.progress || 0, label: job.label || "",
    currentFile: job.currentFile || "", error: msg.error,
  });
  if (history.value.length > 50) history.value.length = 50;
}

function handleJobUpdate(msg) {
  if (msg.status === "cancelled") {
    const job = running.get(msg.jobId);
    if (job) {
      running.delete(msg.jobId);
      history.value.unshift({
        jobId: msg.jobId, kind: job.kind, status: "cancelled",
        progress: job.progress || 0, label: job.label || "",
        currentFile: job.currentFile || "", error: null,
      });
      if (history.value.length > 50) history.value.length = 50;
    }
  }
}

function handleJobsList(msg) {
  for (const j of msg.jobs) {
    if (!running.has(j.jobId)) running.set(j.jobId, { ...j });
  }
}

// 注册消息处理
const unsubs = [];
onMounted(() => {
  unsubs.push(onSWMessage("job-new", handleJobNew));
  unsubs.push(onSWMessage("job-progress", handleJobProgress));
  unsubs.push(onSWMessage("job-done", handleJobDone));
  unsubs.push(onSWMessage("job-error", handleJobError));
  unsubs.push(onSWMessage("job-update", handleJobUpdate));
  unsubs.push(onSWMessage("jobs-list", handleJobsList));

  // 初始同步
  sendToSW({ type: "list-jobs" });
});

onUnmounted(() => {
  // cleanup not needed for single-page app,
  // but keep for correctness
});
</script>
