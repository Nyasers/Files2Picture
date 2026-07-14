<template>
  <div class="panel">
    <div class="card">
      <div class="card-header">
        <h2>文件列表</h2>
        <div class="card-actions">
          <button class="btn-ghost" @click="clearFiles">清空</button>
        </div>
      </div>

      <div
        class="drop-zone"
        :class="{ 'drag-over': dragOver }"
        @dragenter.prevent="onDragEnter"
        @dragover.prevent
        @dragleave.prevent="onDragLeave"
        @drop.prevent="onDrop"
        @click="fileInput?.click()"
      >
        <input
          ref="fileInput"
          type="file"
          multiple
          class="file-input-hidden"
          @change="onFileInput"
        />
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="drop-icon">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="17 8 12 3 7 8"/>
          <line x1="12" y1="3" x2="12" y2="15"/>
        </svg>
        <div class="drop-text">{{ files.length ? files.length + ' 个文件已选择' : '拖放文件到此处' }}</div>
        <div class="drop-hint">支持任意格式，点击选择或拖放添加</div>
      </div>

      <div class="field-row">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="field-icon">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
        </svg>
        <input
          v-model="password"
          type="text"
          class="input"
          placeholder="加密密码（可留空）"
          autocomplete="off"
        />
      </div>

      <!-- 参数 + 操作按钮 -->
      <div class="controls-row">
        <div class="param-group">
          <label>分卷</label>
          <select v-model="targetBmpSize" class="select">
            <option value=""></option>
            <option value="10">10 MB</option>
            <option value="25">25 MB</option>
            <option value="30">30 MB</option>
            <option value="100">100 MB</option>
            <option value="512">512 MB</option>
            <option value="1000">1000 MB</option>
            <option value="1024">1024 MB</option>
            <option value="4092">4092 MB</option>
          </select>
        </div>
        <button class="btn-primary" :disabled="!files.length || encoding" @click="submitEncode">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 20h9"/>
            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
          </svg>
          {{ encoding ? '准备中…' : '生成' }}
        </button>
      </div>

      <div v-if="bmpSizeWarn" class="param-warn" style="margin-top:8px">{{ bmpSizeWarn }}</div>

      <!-- 文件列表（显示在按钮下方） -->
      <div v-if="files.length" class="file-list">
        <div class="file-list-summary">
          共 {{ files.length }} 个文件 · {{ fmt(totalSize) }}
        </div>
        <div class="file-list-header">
          <span class="col-idx">#</span>
          <span class="col-name sortable" @click="sortByName">文件名</span>
          <span class="col-size sortable" @click="sortBySize">大小</span>
          <span class="col-action"></span>
        </div>
        <div class="file-list-body" ref="fileBodyEl">
          <div
            v-for="(f, i) in files"
            :key="f.id"
            class="file-item"
            :class="{ dragging: dragIdx === i }"
            draggable="true"
            @dragstart="onDragStart(i)"
            @dragend="onDragEnd"
            @dragover.prevent="onDragOver(i)"
            @drop.prevent="onDropFile(i)"
          >
            <span class="col-idx">{{ i + 1 }}</span>
            <span class="col-name" :title="f.name">{{ f.name }}</span>
            <span class="col-size">{{ fmt(f.size) }}</span>
            <button class="btn-remove" @click="removeFile(i)" title="移除">✕</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from "vue";
import { fmt } from "../lib/f2p-core.js";
import { sendToSW, waitForSw, triggerDownload, toast } from "../lib/sw-client.js";
import { chunkSize, targetBmpSize } from "../composables/useSettings.js";

const emit = defineEmits(["encode-done"]);

const files = ref([]);
const password = ref("");
const encoding = ref(false);
const dragOver = ref(false);
const bmpSizeWarn = ref("");

const totalSize = computed(() => files.value.reduce((s, f) => s + f.size, 0));
let dragCount = 0;
const dragIdx = ref(null);
const fileInput = ref(null);

let idCounter = 0;
function nextId() { return ++idCounter; }

function addFiles(newFiles) {
  const exist = new Set(files.value.map((f) => f.name + "|" + f.size));
  let added = 0;
  for (const f of newFiles) {
    const key = f.name + "|" + f.size;
    if (exist.has(key)) continue;
    files.value.push({ id: nextId(), file: f, name: f.name, size: f.size });
    exist.add(key);
    added++;
  }
  if (added) toast("已添加 " + added + " 个文件");
}

function removeFile(i) { files.value.splice(i, 1); }
function clearFiles() { files.value = []; }
function sortByName() { files.value.sort((a, b) => a.name.localeCompare(b.name)); }
function sortBySize() { files.value.sort((a, b) => a.size - b.size); }

function onDragEnter() { dragCount++; dragOver.value = true; }
function onDragLeave() { dragCount--; if (dragCount <= 0) { dragCount = 0; dragOver.value = false; } }
function onDrop(e) {
  dragCount = 0; dragOver.value = false;
  if (e.dataTransfer.items) {
    for (const it of e.dataTransfer.items) {
      if (it.webkitGetAsEntry?.()?.isDirectory) { toast("不支持文件夹"); return; }
    }
  }
  if (e.dataTransfer.files.length) addFiles(Array.from(e.dataTransfer.files));
}
function onFileInput(e) {
  const f = Array.from(e.target.files); e.target.value = "";
  if (f.length) addFiles(f);
}

function onDragStart(i) { dragIdx.value = i; }
function onDragEnd() { dragIdx.value = null; }
function onDragOver(i) { }
function onDropFile(i) {
  if (dragIdx.value === null || dragIdx.value === i) { dragIdx.value = null; return; }
  const arr = files.value;
  const [item] = arr.splice(dragIdx.value, 1);
  arr.splice(i, 0, item);
  dragIdx.value = null;
}

// 分卷校验
watch([files, targetBmpSize], () => {
  const mb = parseInt(targetBmpSize.value) || 0;
  if (mb <= 0 || !files.value.length) { bmpSizeWarn.value = ""; return; }
  const nameLen = files.value.reduce((s, f) => s + new TextEncoder().encode(f.name).length, 0);
  const fileListSize = files.value.length * (2 + 8) + nameLen;
  const minEnc = 32 + fileListSize;
  const avail = mb * 1048576 - 54 - 8 - 36;
  if (avail < minEnc) {
    const need = Math.ceil((minEnc + 54 + 8 + 36) / 1048576);
    bmpSizeWarn.value = "分卷太小，至少 " + need + " MB";
  } else {
    bmpSizeWarn.value = "";
  }
}, { deep: true });

async function submitEncode() {
  if (!files.value.length || encoding.value) return;
  encoding.value = true;

  await waitForSw();
  const pwd = password.value;
  const cs = parseInt(chunkSize.value) || 64;
  const selFiles = files.value.slice();
  const jobId = Date.now() + "";
  const bmpSize = (parseInt(targetBmpSize.value) || 0) * 1048576;

  if (bmpSize > 0) {
    const nameLen = selFiles.reduce((s, f) => s + new TextEncoder().encode(f.name).length, 0);
    const fileListSize = selFiles.length * (2 + 8) + nameLen;
    const minEnc = 32 + fileListSize;
    const avail = bmpSize - 54 - 8 - 36;
    if (avail < minEnc) {
      const need = Math.ceil((minEnc + 54 + 8 + 36) / 1048576);
      toast("文件列表装不下索引分卷，至少需要 " + need + " MB");
      encoding.value = false;
      return;
    }
  }

  sendToSW({
    type: "encode", files: selFiles.map((f) => f.file),
    password: pwd, targetBmpSize: bmpSize, chunkSize: cs, jobId,
  });

  const ready = await new Promise((resolve) => {
    const handler = (e) => {
      if (e.data?.jobId === jobId && e.data?.type === "encode-ready") {
        navigator.serviceWorker.removeEventListener("message", handler);
        resolve(e.data);
      }
    };
    navigator.serviceWorker.addEventListener("message", handler);
    setTimeout(() => {
      navigator.serviceWorker.removeEventListener("message", handler);
      resolve(null);
    }, 10000);
  });

  if (!ready) { toast("编码准备超时"); encoding.value = false; return; }

  files.value = [];
  encoding.value = false;

  emit("encode-done");

  for (let i = 0; i < ready.segCount; i++) {
    triggerDownload("/files?id=" + jobId + "&idx=" + i);
  }
}
</script>
