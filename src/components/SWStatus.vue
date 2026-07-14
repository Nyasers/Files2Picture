<template>
  <div class="sw-status" :class="color" @click="onClick">
    <span class="sw-dot" :class="color"></span>
    <span class="sw-name">Service Worker:</span>
    <span class="sw-label">{{ label }}</span>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from "vue";
import { onStatusChange, onToast } from "../lib/sw-client.js";

const color = ref("gray");
const label = ref("初始化...");

let unsubStatus = null;

onMounted(() => {
  unsubStatus = onStatusChange((c, l) => {
    color.value = c;
    label.value = l;
  });
});

onUnmounted(() => {
  if (unsubStatus) unsubStatus();
});

function onClick() {
  if (color.value === "orange") location.reload();
}
</script>
