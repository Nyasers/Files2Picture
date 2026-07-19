<template>
  <div class="app-shell">
    <div class="app-header">
      <div class="app-brand">
        <svg class="app-logo" width="24" height="24" viewBox="0 0 64 64" fill="none" aria-hidden="true">
          <path d="M23 13h21l10 8v27a3 3 0 0 1-3 3H23a3 3 0 0 1-3-3V16a3 3 0 0 1 3-3z" fill="var(--accent)"/>
          <path d="M44 13l10 8" fill="none" stroke="var(--accent-hover)" stroke-width="1.5" stroke-linecap="round"/>
          <rect x="25" y="22" width="13" height="2" rx="0.5" fill="rgba(255,255,255,0.20)"/>
          <rect x="25" y="27" width="10" height="2" rx="0.5" fill="rgba(255,255,255,0.15)"/>
          <rect x="26" y="38" width="3.5" height="3.5" rx="0.7" fill="var(--accent)"/>
          <rect x="31.5" y="38" width="3.5" height="3.5" rx="0.7" fill="var(--success)"/>
          <rect x="37" y="38" width="3.5" height="3.5" rx="0.7" fill="#9b7fd4"/>
        </svg>
        <h1 class="app-title">F2P</h1>
        <span class="app-tagline">隐于无形，读之如晤</span>
      </div>
    </div>

    <TopBar
      :activeTab="activeTab"
      @tab-change="switchTab"
    />

    <EncodePanel
      v-show="activeTab === 'enc'"
      @encode-done="switchTab('tasks')"
    />
    <DecodePanel v-show="activeTab === 'dec'" />
    <TasksPanel v-show="activeTab === 'tasks'" />

    <div class="app-footer">
      <SWStatus />
    </div>
    <ToastHost />
  </div>
</template>

<script setup>
import { ref } from "vue";
import TopBar from "./components/TopBar.vue";
import EncodePanel from "./components/EncodePanel.vue";
import DecodePanel from "./components/DecodePanel.vue";
import TasksPanel from "./components/TasksPanel.vue";
import SWStatus from "./components/SWStatus.vue";
import ToastHost from "./components/ToastHost.vue";

const activeTab = ref("enc");

function switchTab(tab) {
  activeTab.value = tab;
  try {
    sessionStorage.setItem("f2p.tab", tab);
  } catch {}
}

// 恢复上次选中的标签
try {
  const saved = sessionStorage.getItem("f2p.tab");
  if (saved && ["enc", "dec", "tasks"].includes(saved)) {
    activeTab.value = saved;
  }
} catch {}
</script>
