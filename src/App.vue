<template>
  <div class="app-shell">
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

    <SWStatus />
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
