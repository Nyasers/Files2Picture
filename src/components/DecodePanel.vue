<template>
  <div class="panel">
    <div class="card">
      <div class="card-header">
        <h2>选择图片</h2>
        <div class="card-actions">
          <button class="btn-ghost" @click="resetAll">清空</button>
        </div>
      </div>

      <!-- 拖放区 -->
      <div
        class="drop-zone"
        :class="{ 'drag-over': dragOver }"
        @dragenter.prevent="onDragEnter"
        @dragover.prevent
        @dragleave.prevent="onDragLeave"
        @drop.prevent="onDrop"
        @click="$refs.imageInput.click()"
      >
        <input
          ref="imageInput"
          type="file"
          multiple
          accept="image/bmp"
          class="file-input-hidden"
          @change="onFileInput"
        />
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="drop-icon">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
          <circle cx="8.5" cy="8.5" r="1.5"/>
          <polyline points="21 15 16 10 5 21"/>
        </svg>
        <div class="drop-text">{{ images.length ? images.length + ' 张图片已选择' : '拖放 BMP 图片到此处' }}</div>
        <div class="drop-hint">{{ detectSummary }}</div>
      </div>

      <!-- 密码 -->
      <div class="field-row">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="field-icon">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
        </svg>
        <input
          v-model="password"
          type="text"
          class="input"
          placeholder="解密密码（可留空）"
          autocomplete="off"
        />
      </div>

      <!-- 操作按钮（清除在右上角） -->
      <div class="controls-row" v-if="images.length && !decodeResult">
        <button class="btn-primary" @click="submitDecode" :disabled="decoding">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 12a9 9 0 1 1-9-9"/>
            <path d="M12 3v9l4 4"/>
          </svg>
          {{ decoding ? '解码中…' : '提取' }}
        </button>
      </div>

      <!-- 已选择图片列表（显示在按钮下方） -->
      <div v-if="images.length && !decodeResult" class="file-list">
        <div class="file-list-summary">
          共 {{ images.length }} 张图片 · {{ fmt(imageTotalSize) }}
        </div>
        <div class="file-list-body">
          <div
            v-for="(img, i) in images"
            :key="img.id"
            class="file-item"
          >
            <span class="col-idx">{{ i + 1 }}</span>
            <span class="col-name" :title="img.name">
              {{ img.name }}
              <span v-if="img.detected" class="detect-badge">{{ img.detected }}</span>
            </span>
            <span class="col-size">{{ fmt(img.size) }}</span>
            <button class="btn-remove" @click="removeImage(i)" title="移除">✕</button>
          </div>
        </div>
      </div>

      <!-- 解码结果 -->
      <div v-if="decodeResult" class="decode-result">
        <div class="file-list">
          <div class="result-header">
            <input type="checkbox" :checked="allSelected" @change="toggleAll" class="select-all-cb" />
            <span class="result-summary">
              共 {{ decodeResult.entries.length }} 个文件 · {{ fmt(totalExtractSize) }}
            </span>
            <span class="selected-count">已选 {{ selectedCount }} 个 · {{ fmt(selectedSize) }}</span>
            <button class="btn-secondary" @click="batchDownload" :disabled="!selectedCount">
              下载选中
            </button>
          </div>
          <div class="file-list-body">
            <div
              v-for="(entry, i) in decodeResult.entries"
              :key="i"
              class="file-item result-item"
            >
              <input type="checkbox" v-model="selected[i]" :true-value="true" :false-value="false" />
              <span class="col-name">{{ entry.name }}</span>
              <span class="col-size">{{ fmt(entry.size) }}</span>
              <button class="btn-dl" @click="downloadFile(i)">下载</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, nextTick } from "vue";
import { fmt } from "../lib/f2p-core.js";
import {
  quickDetect, decodeContainer, readF2P6Header,
  decodeIndexSegment, verifyDataSegment, extractFileData
} from "../lib/f2p-decode.js";
import {
  sendToSW, waitForSw, triggerDownload, toast
} from "../lib/sw-client.js";
import { chunkSize } from "../composables/useSettings.js";

// 状态
const images = ref([]);
const password = ref("");
const decoding = ref(false);
const dragOver = ref(false);
let dragCount = 0;

// 解码结果
const decodeResult = ref(null);
const selected = reactive({});

let idCounter = 0;
function nextId() { return ++idCounter; }

const imageTotalSize = computed(() => images.value.reduce((s, e) => s + e.size, 0));

const totalExtractSize = computed(() => {
  if (!decodeResult.value) return 0;
  return decodeResult.value.entries.reduce((s, e) => s + e.size, 0);
});

const selectedCount = computed(() => {
  return Object.values(selected).filter(Boolean).length;
});

const selectedSize = computed(() => {
  if (!decodeResult.value) return 0;
  return decodeResult.value.entries.reduce((s, e, i) => selected[i] ? s + e.size : s, 0);
});

const allSelected = computed(() => {
  if (!decodeResult.value) return false;
  return decodeResult.value.entries.length > 0 && selectedCount.value === decodeResult.value.entries.length;
});

const detectSummary = computed(() => {
  const total = images.value.length;
  const detected = images.value.filter((i) => i.detected).length;
  if (!total) return "通过文件头自动识别 F2P 格式";
  return detected + " / " + total + " 个识别为 F2P 格式";
});

// 添加图片
function addImages(newFiles) {
  const exist = new Set(images.value.map((i) => i.name + "|" + i.size));
  let added = 0;
  for (const f of newFiles) {
    const key = f.name + "|" + f.size;
    if (exist.has(key)) continue;
    const entry = { id: nextId(), blob: f, name: f.name, size: f.size, detected: null };
    images.value.push(entry);
    exist.add(key);
    added++;

    // 异步检测（通过 id 找到响应式对象再赋值）
    quickDetect(f).then((d) => {
      const target = images.value.find(e => e.id === entry.id);
      if (target) target.detected = d;
    }).catch(() => {});
  }
  if (added) toast("已添加 " + added + " 张图片");
}

function removeImage(i) {
  images.value.splice(i, 1);
}

function resetAll() {
  images.value = [];
  decodeResult.value = null;
  for (const key of Object.keys(selected)) delete selected[key];
}

// 拖放
function onDragEnter() {
  dragCount++;
  dragOver.value = true;
}
function onDragLeave() {
  dragCount--;
  if (dragCount <= 0) { dragCount = 0; dragOver.value = false; }
}
function onDrop(e) {
  dragCount = 0;
  dragOver.value = false;
  if (!e.dataTransfer.files.length) return;
  if (decodeResult.value) resetAll();
  addImages(Array.from(e.dataTransfer.files));
}
function onFileInput(e) {
  const f = Array.from(e.target.files);
  e.target.value = "";
  if (!f.length) return;
  if (decodeResult.value) resetAll();
  addImages(f);
}

// 全选/取消
function toggleAll() {
  if (!decodeResult.value) return;
  const all = allSelected.value;
  decodeResult.value.entries.forEach((_, i) => {
    selected[i] = !all;
  });
}

// 解码
async function submitDecode() {
  if (!images.value.length || decoding.value) return;
  decoding.value = true;

  const pwd = password.value;

  try {
    // F2P6 多分卷
    if (images.value.some((e) => e.detected?.includes("F2P6"))) {
      const blobs = images.value.map((e) => e.blob);
      let indexBlob = null;
      const dataBlobs = [];

      for (const blob of blobs) {
        try {
          const hdr = await readF2P6Header(blob);
          if (hdr.segID === 0) indexBlob = blob;
          else dataBlobs.push({ segID: hdr.segID, blob });
        } catch {
          throw new Error("不属于同一组分卷");
        }
      }
      if (!indexBlob) throw new Error("未找到索引分卷 (segID=0)");

      const indexInfo = await decodeIndexSegment(indexBlob, pwd, parseInt(chunkSize.value) || 64);
      const dataSegments = [];

      if (indexInfo.segCount > 1) {
        for (const db of dataBlobs) {
          const info = await verifyDataSegment(db.blob, indexInfo.key, indexInfo.indexSalt);
          dataSegments.push({ ...info, blob: db.blob });
        }
        dataSegments.sort((a, b) => a.segID - b.segID);
        if (dataSegments.length < indexInfo.segCount - 1) {
          const missing = [];
          for (let i = 1; i < indexInfo.segCount; i++)
            if (!dataSegments.some((s) => s.segID === i)) missing.push(i);
          throw new Error("缺少数据分卷: " + missing.join(", "));
        }
      }

      decodeResult.value = { type: "f2p6", entries: indexInfo.entries, indexInfo, dataSegments };
      initSelected();
      toast("F2P6 解码完成，共 " + indexInfo.entries.length + " 个文件");
      return;
    }

    // 单 BMP 解码（F2P1-F2P5）
    const hasNonF2P6 = images.value.some((e) => e.detected && !e.detected.includes("F2P6"));
    if (!hasNonF2P6 || images.value.length !== 1) {
      if (hasNonF2P6 && images.value.length > 1)
        toast("混合了 F2P6 和非 F2P6 文件，无法解码");
      return;
    }

    const legacyBlob = images.value[0].blob;
    const result = await decodeContainer(legacyBlob, pwd);
    decodeResult.value = {
      type: "legacy",
      file: legacyBlob,
      entries: result.entries,
      key: result.key,
      bmpMeta: result.meta || null,
      dataStart: result.dataStart || 0,
    };
    initSelected();
    toast("解码完成，共 " + result.entries.length + " 个文件");
  } catch (e) {
    toast("解码失败: " + (e.message || ""));
  } finally {
    decoding.value = false;
  }
}

function initSelected() {
  for (const key of Object.keys(selected)) delete selected[key];
  if (decodeResult.value) {
    decodeResult.value.entries.forEach((_, i) => { selected[i] = true; });
  }
}

// 下载
async function downloadFile(idx) {
  if (!decodeResult.value) return;
  const ent = decodeResult.value.entries[idx];
  try {
    if (decodeResult.value.type === "f2p6") {
      const gid = await prepareF2P6Decode();
      triggerDownload("/files?id=" + gid + "&idx=" + idx);
    } else {
      await waitForSw();
      const jobId = Date.now() + "";
      const keyRaw = decodeResult.value.key
        ? Array.from(new Uint8Array(await crypto.subtle.exportKey("raw", decodeResult.value.key)))
        : null;
      sendToSW({
        type: "decode-stream-prepare", jobId,
        bmpFile: decodeResult.value.file,
        offset: ent.offset, size: ent.size,
        counter: ent.counter ? Array.from(ent.counter) : null,
        bits: ent.bits || 0, name: ent.name,
        keyRaw, chunkSize: parseInt(chunkSize.value) || 64,
      });
      triggerDownload("/files?id=" + jobId);
    }
  } catch (e) {
    toast("下载失败: " + (e.message || ""));
  }
}

async function batchDownload() {
  if (!decodeResult.value) return;
  const indices = Object.entries(selected)
    .filter(([, v]) => v)
    .map(([k]) => parseInt(k));
  if (!indices.length) { toast("请选择文件"); return; }

  try {
    if (decodeResult.value.type === "f2p6") {
      const gid = await prepareF2P6Decode();
      for (const idx of indices) {
        triggerDownload("/files?id=" + gid + "&idx=" + idx);
      }
    } else {
      await waitForSw();
      const keyRaw = decodeResult.value.key
        ? Array.from(new Uint8Array(await crypto.subtle.exportKey("raw", decodeResult.value.key)))
        : null;
      const files = indices.map((idx) => {
        const e = decodeResult.value.entries[idx];
        return {
          offset: e.offset, size: e.size,
          counter: e.counter ? Array.from(e.counter) : null,
          bits: e.bits || 0, name: e.name,
        };
      });
      const gid = Date.now() + "";
      sendToSW({ type: "decode-group", id: gid, files, bmpFile: decodeResult.value.file, keyRaw, chunkSize: parseInt(chunkSize.value) || 64 });
      for (let i = 0; i < files.length; i++) {
        triggerDownload("/files?id=" + gid + "&idx=" + i);
      }
    }
  } catch (e) {
    toast("批量下载失败: " + (e.message || ""));
  }
}

async function prepareF2P6Decode() {
  await waitForSw();
  const rawKey = await crypto.subtle.exportKey("raw", decodeResult.value.indexInfo.key);
  const gid = Date.now() + "";
  sendToSW({
    type: "f2p6-decode-group", id: gid,
    entries: decodeResult.value.indexInfo.entries,
    keyRaw: Array.from(new Uint8Array(rawKey)),
    indexBlob: decodeResult.value.indexInfo.bmpMeta.blob,
    indexSegSalt: Array.from(decodeResult.value.indexInfo.segSalt),
    dataInIndex: decodeResult.value.indexInfo.dataInIndex,
    indexDataPayloadOffset: decodeResult.value.indexInfo.indexDataPayloadOffset,
    dataSegments: decodeResult.value.dataSegments.map((s) => ({
      segID: s.segID, segSalt: Array.from(s.segSalt),
      dataSize: s.dataSize, dataOffset: s.dataOffset, blob: s.bmpMeta.blob,
    })),
    chunkSize: parseInt(chunkSize.value) || 64,
  });
  return gid;
}
</script>
