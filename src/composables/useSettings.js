// ═══════════════════════════════════════════════
// 全局设置 — 跨组件共享的响应式状态
// ═══════════════════════════════════════════════
import { ref, watch } from "vue";

// ── 分片大小 ──

export const CHUNK_SIZES = [
  64, 256, 1024, 2048, 3072, 4096, 6144, 8192, 12288, 16384,
  24576, 32768, 49152, 65536, 98304, 131072, 196608, 262144,
  393216, 524288, 786432, 1048576, 1572864, 2097152, 3145728, 3932160,
];

const savedChunk = (() => {
  try {
    const v = sessionStorage.getItem("f2p.chunkSize");
    if (v && CHUNK_SIZES.includes(parseInt(v))) return parseInt(v);
  } catch {}
  return 64;
})();

export const chunkSize = ref(savedChunk);

watch(chunkSize, (v) => {
  try { sessionStorage.setItem("f2p.chunkSize", v); } catch {}
});

export function fmtChunk(kb) {
  return kb < 1024 ? kb + " KB" : (kb / 1024) + " MB";
}

// ── 分卷大小 ──

const savedBmp = (() => {
  try {
    const v = sessionStorage.getItem("f2p.bmpSize");
    if (v && ["0","10","25","30","100","512","1000","1024","4092"].includes(v)) return v;
  } catch {}
  return "0";
})();

export const targetBmpSize = ref(savedBmp);

watch(targetBmpSize, (v) => {
  try { sessionStorage.setItem("f2p.bmpSize", v); } catch {}
});
