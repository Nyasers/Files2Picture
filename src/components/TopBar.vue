<template>
  <div class="top-bar">
    <div class="mode-tabs">
      <button
        class="mode-btn"
        :class="{ active: activeTab === 'enc' }"
        @click="$emit('tab-change', 'enc')"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="1.5" y="1.5" width="13" height="13" rx="2" stroke="currentColor" stroke-width="1.5"/>
          <path d="M5 8 L7 10 L11 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        编码
      </button>
      <button
        class="mode-btn"
        :class="{ active: activeTab === 'dec' }"
        @click="$emit('tab-change', 'dec')"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="1.5" y="1.5" width="13" height="13" rx="2" stroke="currentColor" stroke-width="1.5"/>
          <path d="M5 5 L8 2 L11 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M8 2 L8 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        解码
      </button>
      <button
        class="mode-btn"
        :class="{ active: activeTab === 'tasks' }"
        @click="$emit('tab-change', 'tasks')"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="2" y="2" width="4" height="4" rx="1" stroke="currentColor" stroke-width="1.5"/>
          <rect x="2" y="10" width="4" height="4" rx="1" stroke="currentColor" stroke-width="1.5"/>
          <rect x="9" y="2.5" width="5" height="3" rx="1" stroke="currentColor" stroke-width="1.5"/>
          <rect x="9" y="10.5" width="5" height="3" rx="1" stroke="currentColor" stroke-width="1.5"/>
        </svg>
        任务
      </button>
    </div>

    <div class="top-controls">
      <div class="param-group">
        <label>分块</label>
        <select v-model="chunkSize" class="select">
          <option v-for="s in CHUNK_SIZES" :key="s" :value="s">{{ fmtChunk(s) }}</option>
        </select>
        <span class="mem-hint" :class="memLevel" :title="memTitle"></span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from "vue";
import { chunkSize, CHUNK_SIZES, fmtChunk } from "../composables/useSettings.js";

defineProps({
  activeTab: { type: String, required: true },
});
defineEmits(["tab-change"]);

const peakMem = computed(() => (parseInt(chunkSize.value) || 64) * 8);
const memLevel = computed(() => {
  const p = peakMem.value;
  if (p < 262144) return "";
  if (p < 1048576) return "warn";
  return "danger";
});
const memTitle = computed(() => {
  if (!memLevel.value) return "内存占用正常";
  return "内存占用偏高 (峰值 " + fmtChunk(peakMem.value) + ")";
});
</script>
