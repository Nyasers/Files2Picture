<template>
  <div class="toast-container">
    <div
      v-for="(t, i) in toasts"
      :key="t.id"
      class="toast"
      :class="{ out: t.out }"
    >{{ t.text }}</div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from "vue";
import { onToast } from "../lib/sw-client.js";

const toasts = ref([]);
let id = 0;
let unsub = null;

onMounted(() => {
  unsub = onToast((text, duration) => {
    const toastId = ++id;
    toasts.value.push({ id: toastId, text, out: false });
    setTimeout(() => {
      const t = toasts.value.find((x) => x.id === toastId);
      if (t) t.out = true;
      setTimeout(() => {
        const idx = toasts.value.findIndex((x) => x.id === toastId);
        if (idx >= 0) toasts.value.splice(idx, 1);
      }, 300);
    }, duration || 3000);
  });
});

onUnmounted(() => {
  if (unsub) unsub();
});
</script>
