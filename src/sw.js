// ═══════════════════════════════════════════════
// F2P Service Worker — 任务执行 + 流式下载 + PWA 缓存
// ═══════════════════════════════════════════════
"use strict";

import {
  deriveEncKey,
  aesEncrypt,
  aesDecrypt,
  buildBMPStream,
  readBmpHeader,
  readPayload,
} from "./lib/f2p-core.js";
import {
  precomputeSegments,
  encodeIndexSegment,
  encodeDataSegment,
  buildFileEntriesFromFiles,
} from "./lib/f2p-encode.js";
import { extractFileDataRange } from "./lib/coders/f2p6-decode.js";

// ═══════════════════════════════════════════════
// PWA 缓存配置 — hash-manifest 驱动，替代 TTL SWR
//   - 构建时生成 hash-manifest.json（{ "/路径": "sha256" }）
//   - SW 通过 IndexedDB 持久化 hash 表
//   - 更新时只拉取 hash 变化的文件
//   - 激活后清理孤立缓存
// ═══════════════════════════════════════════════

const CACHE_NAME = "f2p-v1";
const DB_NAME = "f2p-cache";
const STORE_NAME = "hashes";
const DB_VERSION = 1;
const MANIFEST_URL = "/hashes.json";

// ── IndexedDB 工具 ──

async function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME))
        db.createObjectStore(STORE_NAME, { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getAllHashes() {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () =>
      resolve(
        req.result.reduce((acc, { key, hash }) => ((acc[key] = hash), acc), {}),
      );
    req.onerror = () => resolve({});
  });
}

async function bulkSetHashes(manifest) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.clear();
    Object.entries(manifest).forEach(([key, hash]) => store.put({ key, hash }));
    tx.oncomplete = () => {
      cachedPaths = new Map(Object.entries(manifest));
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

// ── workOnce: 相同 key 的并发请求合并 ──

function workOnce(key, task) {
  const inflight = (workOnce.p ??= new Map());
  return (
    inflight.get(key) ??
    inflight
      .set(
        key,
        Promise.resolve(task?.()).then(
          (v) => (inflight.delete(key), v),
          (e) => (inflight.delete(key), Promise.reject(e)),
        ),
      )
      .get(key)
  );
}

// ── fetch 超时保护（AbortController）──

const FETCH_TIMEOUT = 10000;

function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms || FETCH_TIMEOUT);
  return fetch(url === "/index.html" ? "/" : url, {
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));
}

// ── 路径白名单（path → hash，与 IndexedDB 同步）──

let cachedPaths = new Map();

// SW 启动时从 IDB 恢复白名单
// 异步执行，加载完成前所有请求走默认浏览器行为
getAllHashes().then(
  (hashes) => {
    cachedPaths = new Map(Object.entries(hashes));
  },
  () => {},
);

// ── 路径归一化 ──

function resolvePath(pn) {
  return pn === "/" ? "/index.html" : pn;
}

// ── Manifest 同步 ──

async function syncManifest() {
  return (syncManifest.promise ??= fetchWithTimeout(MANIFEST_URL)
    .then((res) => res.json())
    .then((raw) => {
      // hashtable.json 的 key 不含前导 /，加上再往下传
      const m = {};
      for (const [key, hash] of Object.entries(raw)) m["/" + key] = hash;
      return m;
    })
    .then((manifest) =>
      syncUpdate(manifest).then((failedPaths) => ({ manifest, failedPaths })),
    )
    .then(({ manifest, failedPaths }) =>
      cleanupOrphans(failedPaths).then(() => manifest),
    )
    .then(
      (manifest) => (
        setTimeout(() => delete syncManifest.promise, 6e4),
        manifest
      ),
      (reason) => (delete syncManifest.promise, Promise.reject(reason)),
    ));
}

async function syncUpdate(manifest) {
  const oldHashes = await getAllHashes();
  const updates = Object.entries(manifest).filter(
    ([key, hash]) => oldHashes[key] !== hash,
  );
  if (updates.length === 0) return;

  // 标记哪些路径的 fetch 失败，cache 不写、cleanup 也不删
  const failedPaths = new Set();

  const results = await Promise.allSettled(
    updates.map(([key, hash]) =>
      workOnce(key, async () => {
        const cache = await caches.open(CACHE_NAME);
        const res = await fetchWithTimeout(key);
        if (res.ok) await cache.put(key + "#" + hash, res.clone());
        else failedPaths.add(key);
        return res;
      }),
    ),
  );

  results.forEach((r, i) => {
    if (r.status === "rejected") failedPaths.add(updates[i][0]);
  });

  // IDB 总是写入最新 manifest（hash 不匹配 = 下次访问自动回源，不是数据丢失）
  await bulkSetHashes(manifest);

  const failedCount = failedPaths.size;
  if (failedCount > 0)
    console.warn(
      "syncUpdate: " + failedCount + "/" + updates.length + " files 失败",
      [...failedPaths],
    );

  const succeededCount = updates.length - failedCount;
  if (succeededCount > 0)
    self.clients
      .matchAll()
      .then((clients) =>
        clients.forEach((client) => client.postMessage({ type: "sw-updated" })),
      );

  return failedPaths; // 传给 cleanupOrphans
}

async function cleanupOrphans(failedPaths) {
  const manifest = await getAllHashes();
  if (Object.keys(manifest).length < 3) {
    console.warn(
      "cleanupOrphans: manifest 条目过少(" +
        Object.keys(manifest).length +
        ")，跳过本次清理",
    );
    return;
  }
  const cache = await caches.open(CACHE_NAME);
  const requests = await cache.keys();
  return Promise.all(
    requests
      .filter((req) => {
        const u = new URL(req.url);
        const pn = u.pathname;
        if (pn.startsWith("/file/")) return false;
        // fetch 失败的路径保留旧缓存，不删
        if (failedPaths?.has(pn)) return false;
        const expectedHash = manifest[pn];
        if (expectedHash === undefined) return true;
        const actualHash = u.hash.slice(1);
        return actualHash !== expectedHash;
      })
      .map((req) => cache.delete(req)),
  );
}

// ── 路径匹配 ──

function isStreamingRoute(pn) {
  return pn === "/files" || pn.startsWith("/file/");
}

function isManifestRoute(pn) {
  return pn === MANIFEST_URL;
}

// ── 缓存服务（仅对白名单内的路径调用）──

async function serveFromCache(request, event) {
  const cache = await caches.open(CACHE_NAME);
  const pn = resolvePath(new URL(request.url).pathname);
  const hash = cachedPaths.get(pn);
  const cacheUrl = pn + "#" + hash;
  const cached = await cache.match(cacheUrl);
  if (cached) return cached;
  try {
    const res = await fetch(request);
    if (res.ok) event?.waitUntil(cache.put(cacheUrl, res.clone()));
    return res;
  } catch {
    return new Response("Offline", {
      status: 503,
      headers: { "Content-Type": "text/plain" },
    });
  }
}

// ── 生命周期 ──

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    syncManifest()
      .catch((e) => console.warn("syncManifest 失败（首次安装或离线）:", e))
      .then(() => self.clients.claim())
      .then(() =>
        self.clients.matchAll().then((cs) => {
          for (const c of cs) c.postMessage({ type: "sw-ready" });
        }),
      ),
  );
});

const jobs = new Map();
const pendingStreams = new Map(); // jobId -> { push, close }
const pendingDecodeStreams = new Map(); // jobId -> { bmpFile, key, offset, size, counter(16B), bits, name }
const pendingDecodeGroups = new Map(); // groupId -> { files: [{offset,size,counter,bits,name}], key, chunkSize }
const pendingEncodeGroups = new Map(); // id -> { jobId, segCount, segments: [{segID, segInfo}] }
const pendingF2P6DecodeGroups = new Map(); // id -> { key, entries, blobs: [bmpMeta], segments }
const fileRoutes = new Map(); // hash -> { id, idx, kind }
let jobIdCounter = 0;

// ── 消息处理 ──

self.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || !msg.type) return;
  if (msg.type === "ping") return;
  switch (msg.type) {
    case "encode": {
      event.waitUntil(runEncode(event, msg));
      break;
    }
    case "cancel":
      cancelJob(msg.jobId);
      break;
    case "list-jobs":
      listJobs(event);
      break;
    case "consume":
      consumeJob(msg.jobId);
      break;
    case "decode-stream-prepare":
      handleDecodeStreamPrepare(event, msg);
      break;
    case "decode-group":
      handleDecodeGroup(event, msg);
      break;
    case "f2p6-decode-group":
      handleF2P6DecodePrepare(event, msg);
      break;
  }
});

// ── 流式下载拦截 + PWA 缓存 ──

self.addEventListener("fetch", async (event) => {
  const url = new URL(event.request.url);

  // ════════════════════════════════════════
  // 导航触发增量更新检查
  //   每次用户打开/刷新页面时后台拉取 hashes.json，对比 hash 做增量缓存更新
  //   syncManifest 内部有 60s promise 缓存，短时间多次导航不会重复 fetch
  // ════════════════════════════════════════

  if (event.request.mode === "navigate") {
    event.waitUntil(
      syncManifest().catch((e) =>
        console.warn("导航触发的 syncManifest 失败:", e),
      ),
    );
  }

  // ════════════════════════════════════════
  // 原有流式下载逻辑
  // ════════════════════════════════════════

  // ── 触发：/files?id=<id>[&idx=<n>] → 302 → /file/<hash>/<filename> ──
  if (url.pathname === "/files" && event.request.method === "GET") {
    event.respondWith(
      (async () => {
        const id = url.searchParams.get("id");
        if (!id) return new Response("缺少 id", { status: 400 });
        const idx = url.searchParams.get("idx");

        // 单文件
        if (idx === null) {
          let fileName;
          const encJob = pendingStreams.get(id);
          if (encJob)
            fileName =
              encJob.name || (jobs.get(id) || {}).filename || "export.bin";
          else {
            const decJob = pendingDecodeStreams.get(id);
            if (decJob) fileName = decJob.name || "file.bin";
          }
          if (!fileName) return new Response("未找到任务", { status: 404 });
          const hash = await computeFileHash(id);
          fileRoutes.set(hash, { id });
          return Response.redirect(
            "/file/" + hash + "/" + encodeURIComponent(fileName),
            302,
          );
        }

        // 分组 — 解码组、编码分卷或 F2P6 解码分卷
        const decGroup = pendingDecodeGroups.get(id);
        const encGroup = pendingEncodeGroups.get(id);
        const f2p6Group = pendingF2P6DecodeGroups.get(id);
        if (!decGroup && !encGroup && !f2p6Group)
          return new Response("未找到分组", { status: 404 });
        const i = parseInt(idx);

        if (f2p6Group) {
          if (isNaN(i) || i >= f2p6Group.entries.length)
            return new Response("索引无效", { status: 400 });
          const fileName = f2p6Group.entries[i].name || "file.bin";
          const hash = await computeFileHash(id, i);
          fileRoutes.set(hash, { id, idx: i, kind: "f2p6-decode" });
          return Response.redirect(
            "/file/" + hash + "/" + encodeURIComponent(fileName),
            302,
          );
        }

        if (encGroup) {
          if (isNaN(i) || i >= encGroup.segCount)
            return new Response("索引无效", { status: 400 });
          const shortId = (+id || Date.now()).toString(36);
          const fileName =
            "F2P." + shortId + "." + i.toString(16).padStart(8, "0") + ".bmp";
          const hash = await computeFileHash(id, i);
          fileRoutes.set(hash, { id, idx: i, kind: "encode" });
          return Response.redirect(
            "/file/" + hash + "/" + encodeURIComponent(fileName),
            302,
          );
        }

        if (isNaN(i) || !decGroup.files[i])
          return new Response("索引无效", { status: 400 });
        const fileName = decGroup.files[i].name || "file.bin";
        const hash = await computeFileHash(id, i);
        fileRoutes.set(hash, { id, idx: i });
        return Response.redirect(
          "/file/" + hash + "/" + encodeURIComponent(fileName),
          302,
        );
      })(),
    );
    return;
  }

  // ── 响应：/file/<hash>/<filename> ──
  if (url.pathname.startsWith("/file/") && event.request.method === "GET") {
    event.respondWith(
      (async () => {
        const parts = url.pathname.split("/").filter(Boolean);
        if (parts.length < 3) return new Response("格式错误", { status: 400 });
        const hash = parts[1];
        const route = fileRoutes.get(hash);
        if (!route) return new Response("未找到任务", { status: 404 });
        fileRoutes.delete(hash);

        if (route.idx !== undefined && route.kind === "encode")
          return serveEncodeSegmentStream(route.id, route.idx);
        if (route.idx !== undefined && route.kind === "f2p6-decode")
          return serveF2P6DecodeStream(route.id, route.idx);
        if (route.idx !== undefined)
          return serveGroupStream(route.id, route.idx);
        return serveStream(route.id);
      })(),
    );
    return;
  }

  // ════════════════════════════════════════
  // PWA 缓存：全量 cache-first
  //   唯一例外：/hashes.json 走网络直通（小文件，必须新鲜）
  // ════════════════════════════════════════

  const pn = url.pathname;
  if (event.request.method === "GET" && !isStreamingRoute(pn)) {
    if (isManifestRoute(pn)) {
      event.respondWith(
        fetch(event.request).catch(
          () =>
            new Response("{}", {
              status: 503,
              headers: { "Content-Type": "application/json" },
            }),
        ),
      );
    } else if (cachedPaths.has(resolvePath(pn))) {
      event.respondWith(serveFromCache(event.request, event));
    }
    // 不在白名单 → 走默认浏览器行为，不拦截
  }
});

// ── 解码流式准备（同步设 pending 条目，key 异步导入推迟到 fetch handler）──

function handleDecodeStreamPrepare(event, msg) {
  const {
    jobId,
    bmpFile,
    offset,
    size,
    counter,
    bits,
    name,
    keyRaw,
    chunkSize = 64,
  } = msg;
  if (!jobId) return;

  const keyPromise = keyRaw
    ? crypto.subtle.importKey(
        "raw",
        new Uint8Array(keyRaw),
        { name: "AES-CTR" },
        false,
        ["decrypt"],
      )
    : Promise.resolve(null);

  pendingDecodeStreams.set(jobId, {
    bmpFile,
    offset,
    size,
    counter: counter ? new Uint8Array(counter) : null,
    bits: bits || 0,
    name,
    chunkSize,
    keyPromise,
  });

  if (event.source)
    event.source.postMessage({ type: "decode-stream-ready", jobId, name });
}

// ── 解码分组准备（同步设 pending 条目，key 异步导入推迟到 fetch handler）──

function handleDecodeGroup(event, msg) {
  const { id, files, bmpFile, keyRaw, chunkSize } = msg;
  if (!id || !files || !files.length || !bmpFile) {
    if (event.source)
      event.source.postMessage({
        type: "decode-group-error",
        id,
        error: "参数不足",
      });
    return;
  }

  const keyPromise = keyRaw
    ? crypto.subtle.importKey(
        "raw",
        new Uint8Array(keyRaw),
        { name: "AES-CTR" },
        false,
        ["decrypt"],
      )
    : Promise.resolve(null);

  pendingDecodeGroups.set(id, {
    bmpFile,
    files: files.map((f) => ({
      ...f,
      counter: f.counter ? new Uint8Array(f.counter) : null,
      bits: f.bits || 0,
    })),
    keyPromise,
    chunkSize: chunkSize || 64,
    dispatched: 0,
  });

  if (event.source)
    event.source.postMessage({ type: "decode-group-ready", id });
}

// ── 工具 ──

async function computeFileHash(id, idx) {
  const input = idx !== undefined ? id + "_" + idx : id;
  const hash = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function serveStream(id) {
  const encJob = pendingStreams.get(id);
  if (encJob) return serveEncodeStream(id);
  const decJob = pendingDecodeStreams.get(id);
  if (decJob) return serveDecodeStream(id);
  return new Response("未找到任务", { status: 404 });
}

function attachHdr() {
  return new Headers({
    "Content-Type": "application/octet-stream; charset=utf-8",
    "Content-Disposition": "attachment",
    "Content-Security-Policy": "default-src 'none'",
  });
}

function postToClients(msg) {
  self.clients.matchAll().then((cs) => {
    for (const c of cs) c.postMessage(msg);
  });
}
function genJobId() {
  return "job_" + ++jobIdCounter + "_" + Date.now().toString(36);
}
function cancelJob(id) {
  const j = jobs.get(id);
  if (j) {
    j.cancelled = true;
    j.status = "cancelled";
    postToClients({ type: "job-update", jobId: id, status: "cancelled" });
  }
}
function consumeJob(id) {
  const j = jobs.get(id);
  if (
    j &&
    (j.status === "done" || j.status === "error" || j.status === "cancelled")
  )
    jobs.delete(id);
}
function listJobs() {
  const list = [];
  for (const [id, j] of jobs)
    list.push({
      jobId: id,
      kind: j.kind,
      status: j.status,
      progress: j.progress || 0,
      label: j.label || "",
      totalFiles: j.totalFiles,
      currentFile: j.currentFile,
      fileNames: j.fileNames,
      filename: j.filename,
      size: j.size,
      error: j.error,
      decodedFiles: j.decodedFiles,
    });
  postToClients({ type: "jobs-list", jobs: list });
}

// ── 流式响应函数（供 fetch handler 调用）──

function serveEncodeStream(id) {
  const encJob = pendingStreams.get(id);
  if (!encJob) return new Response("未找到任务", { status: 404 });
  const fileName = encJob.name || (jobs.get(id) || {}).filename || "export.bin";
  const headers = attachHdr();
  if (encJob.size) headers.set("Content-Length", String(encJob.size));
  const stream = new ReadableStream({
    start(c) {
      encJob.push = (d) => c.enqueue(d);
      encJob.close = () => {
        try {
          c.close();
        } catch {}
      };
      if (encJob.pushReady) encJob.pushReady();
    },
    cancel() {
      const j = jobs.get(id);
      if (j) j.cancelled = true;
    },
  });
  return new Response(stream, { headers });
}

async function serveDecodeStream(id) {
  const decJob = pendingDecodeStreams.get(id);
  if (!decJob) return new Response("未找到任务", { status: 404 });
  pendingDecodeStreams.delete(id);
  if (decJob.keyPromise) {
    try {
      decJob.key = await decJob.keyPromise;
    } catch (e) {
      return new Response("密钥导入失败", { status: 500 });
    }
  }
  const fileName = decJob.name || "file.bin";

  const job = {
    kind: "decode",
    status: "running",
    progress: 0,
    currentFile: fileName,
    label: fileName,
    totalFiles: 1,
  };
  jobs.set(id, job);
  postToClients({ type: "job-new", jobId: id, ...job });

  const headers = attachHdr();
  if (decJob.size) headers.set("Content-Length", String(decJob.size));
  const stream = new ReadableStream({
    async start(controller) {
      postToClients({ type: "job-start", jobId: id });
      try {
        const bmp = await readBmpHeader(decJob.bmpFile);
        let pos = decJob.offset,
          left = decJob.size,
          total = decJob.size;
        while (left > 0 && !job.cancelled) {
          const ck = (decJob.chunkSize || 64) * 1024;
          const take = Math.min(left, ck);
          let data;
          data = await readPayload(bmp, pos, take);
          if (job.cancelled) break;
          let out = data;
          if (decJob.key && decJob.counter)
            out = await aesDecrypt(
              data,
              decJob.key,
              decJob.counter,
              (pos - decJob.offset) / 16,
              decJob.bits,
            );
          if (job.cancelled) break;
          controller.enqueue(out);
          left -= take;
          pos += take;
          const done = total - left;
          const pct = Math.min(100, Math.round((done / total) * 100));
          if (pct !== job.progress) {
            job.progress = pct;
            postToClients({
              type: "job-progress",
              jobId: id,
              progress: pct,
              done,
              total,
              currentFile: fileName,
            });
          }
        }
        if (!job.cancelled) {
          controller.close();
          job.status = "done";
          job.progress = 100;
          postToClients({
            type: "job-done",
            jobId: id,
            kind: "decode",
            fileName,
            size: total,
          });
        }
      } catch (e) {
        controller.error(e);
        job.status = "error";
        job.error = e.message;
        postToClients({ type: "job-error", jobId: id, error: e.message });
      }
    },
    cancel() {
      job.cancelled = true;
      job.status = "cancelled";
      postToClients({ type: "job-update", jobId: id, status: "cancelled" });
    },
  });
  return new Response(stream, { headers });
}

async function serveGroupStream(id, idx, filename) {
  const group = pendingDecodeGroups.get(id);
  if (!group) return new Response("未找到分组", { status: 404 });
  if (group.keyPromise) {
    try {
      group.key = await group.keyPromise;
    } catch (e) {
      return new Response("密钥导入失败", { status: 500 });
    }
  }
  const fi = group.files[idx];
  if (!fi) return new Response("索引越界", { status: 404 });
  const fileName = fi.name || "file.bin";

  group.dispatched = (group.dispatched || 0) + 1;
  if (group.dispatched >= group.files.length) pendingDecodeGroups.delete(id);

  const gjId = id + "_" + idx;
  const job = {
    kind: "decode",
    status: "running",
    progress: 0,
    currentFile: fileName,
    label: fileName,
    totalFiles: 1,
  };
  jobs.set(gjId, job);
  postToClients({ type: "job-new", jobId: gjId, ...job });

  const headers = attachHdr();
  if (fi.size) headers.set("Content-Length", String(fi.size));
  const stream = new ReadableStream({
    async start(controller) {
      postToClients({ type: "job-start", jobId: gjId });
      try {
        const bmp = await readBmpHeader(group.bmpFile);
        let pos = fi.offset,
          left = fi.size,
          total = fi.size;
        while (left > 0 && !job.cancelled) {
          const ck = (group.chunkSize || 64) * 1024;
          const take = Math.min(left, ck);
          let data;
          data = await readPayload(bmp, pos, take);
          if (job.cancelled) break;
          let out = data;
          if (group.key && fi.counter)
            out = await aesDecrypt(
              data,
              group.key,
              fi.counter,
              (pos - fi.offset) / 16,
              fi.bits,
            );
          if (job.cancelled) break;
          controller.enqueue(out);
          left -= take;
          pos += take;
          const done = total - left;
          const pct = Math.min(100, Math.round((done / total) * 100));
          if (pct !== job.progress) {
            job.progress = pct;
            postToClients({
              type: "job-progress",
              jobId: gjId,
              progress: pct,
              done,
              total,
              currentFile: fileName,
            });
          }
        }
        if (!job.cancelled) {
          controller.close();
          job.status = "done";
          job.progress = 100;
          postToClients({
            type: "job-done",
            jobId: gjId,
            kind: "decode",
            fileName,
            size: total,
          });
        }
      } catch (e) {
        controller.error(e);
        job.status = "error";
        job.error = e.message;
        postToClients({ type: "job-error", jobId: gjId, error: e.message });
      }
    },
    cancel() {
      job.cancelled = true;
      job.status = "cancelled";
      postToClients({ type: "job-update", jobId: gjId, status: "cancelled" });
    },
  });
  return new Response(stream, { headers });
}

// ── F2P6 解码准备 ──

function handleF2P6DecodePrepare(event, msg) {
  const {
    id,
    entries,
    keyRaw,
    indexBlob,
    indexSegSalt,
    dataInIndex,
    indexDataPayloadOffset,
    dataSegments,
    chunkSize,
  } = msg;
  if (!id || !entries || !keyRaw || !indexBlob || !dataSegments) {
    if (event.source)
      event.source.postMessage({
        type: "f2p6-decode-error",
        id,
        error: "参数不足",
      });
    return;
  }

  pendingF2P6DecodeGroups.set(id, {
    entries,
    keyRaw: new Uint8Array(keyRaw),
    indexBlob,
    indexSegSalt: new Uint8Array(indexSegSalt),
    dataInIndex,
    indexDataPayloadOffset,
    dataSegments,
    chunkSize,
    dispatched: 0,
  });

  if (event.source) event.source.postMessage({ type: "f2p6-decode-ready", id });
}

// ═══════════════════════════════════════════════
// F2P6 编码处理
// ═══════════════════════════════════════════════

/**
 * 处理 F2P6 编码请求
 */
async function runEncode(event, msg) {
  const { files, password, targetBmpSize, chunkSize, jobId } = msg;
  if (!files || !files.length) {
    if (event.source)
      event.source.postMessage({
        type: "encode-error",
        jobId,
        error: "无文件",
      });
    return;
  }

  try {
    const segInfo = precomputeSegments(
      files.map((f) => ({ name: f.name, size: f.size })),
      targetBmpSize,
    );

    const segSalt = crypto.getRandomValues(new Uint8Array(16));
    const iter = 10000;
    const encKey = await deriveEncKey(password, segSalt, iter);
    const indexSalt = crypto.getRandomValues(new Uint8Array(16));

    // 预计算 encMagic 和 fileEntries，供 encodeIndexSegment 复用
    const emFull = await aesEncrypt(
      new Uint8Array([0x46, 0x32, 0x50, 0x36]),
      encKey,
      segSalt,
      0,
      128,
    );
    const encMagic = emFull.subarray(0, 4);
    const fileEntries = buildFileEntriesFromFiles(files, segInfo.nameBufs);

    jobs.set(jobId, {
      kind: "encode",
      files,
      password,
      targetBmpSize,
      chunkSize,
      segInfo,
      encKey,
      segSalt,
      iter,
      indexSalt,
      status: "running",
      progress: 0,
      cancelled: false,
      currentFile: "",
      fileNames: files.map((f) => f.name),
      totalFiles: files.length,
      label: files.length + " 个文件编码",
      encMagic,
      fileEntries,
    });

    postToClients({
      type: "job-new",
      jobId,
      kind: "encode",
      status: "running",
      progress: 0,
      totalFiles: files.length,
      label: files.length + " 个文件编码",
    });

    // 注册编码分组（供 /files?id=X&idx=Y 查找）
    const prefixSum = [0];
    for (let i = 1; i < segInfo.segCount; i++)
      prefixSum[i] = prefixSum[i - 1] + segInfo.segments[i - 1].dataSize;

    pendingEncodeGroups.set(jobId, {
      jobId,
      segCount: segInfo.segCount,
      segments: segInfo.segments,
      pending: new Array(segInfo.segCount).fill(null),
      encodingStarted: false,
      prefixSum,
    });

    if (event.source)
      event.source.postMessage({
        type: "encode-ready",
        jobId,
        segCount: segInfo.segCount,
        segments: segInfo.segments.map((s) => ({
          segID: s.segID,
          type: s.type,
          dataSize: s.dataSize,
          payloadSize: s.payloadSize,
        })),
        totalSize: segInfo.fileTotalData,
      });
  } catch (e) {
    console.error("编码准备失败", e);
    if (event.source)
      event.source.postMessage({
        type: "encode-error",
        jobId,
        error: e.message,
      });
  }
}

/**
 * 编码分卷流式响应 — 被 /file/<hash>/<filename> 调用
 */
async function serveEncodeSegmentStream(id, idx) {
  const job = jobs.get(id);
  if (!job || !job.segInfo) return new Response("任务不存在", { status: 404 });
  const segInfo = job.segInfo.segments[idx];
  if (!segInfo) return new Response("分卷不存在", { status: 404 });

  const group = pendingEncodeGroups.get(id);
  if (!group) return new Response("分组不存在", { status: 404 });

  const shortId = (+id || Date.now()).toString(36);
  const fileName =
    "F2P." + shortId + "." + idx.toString(16).padStart(8, "0") + ".bmp";

  // 创建延期响应：编码协调器完成后会 resolve 这个 stream
  let resolveStream;
  const streamPromise = new Promise((resolve) => {
    resolveStream = resolve;
  });
  group.pending[idx] = resolveStream;

  // 第一个请求触发顺序编码协调器
  if (!group.encodingStarted) {
    group.encodingStarted = true;
    encodeSegmentsSequentially(id).catch((e) => {
      console.error("顺序编码失败", e);
      const g = pendingEncodeGroups.get(id);
      if (g) {
        for (let i = 0; i < g.pending.length; i++) {
          if (g.pending[i])
            g.pending[i](new Response("编码失败", { status: 500 }));
        }
        pendingEncodeGroups.delete(id);
      }
    });
  }

  const stream = await streamPromise;

  const totalSize = 54 + 8 + segInfo.payloadSize;
  const headers = new Headers({
    "Content-Type": "image/bmp",
    "Content-Disposition": 'attachment; filename="' + fileName + '"',
    "Content-Length": String(totalSize),
  });
  return new Response(stream, { headers });
}

/**
 * 顺序编码协调器 — 按分卷顺序逐个编码，降低内存峰值
 */
async function encodeSegmentsSequentially(id) {
  const job = jobs.get(id);
  const group = pendingEncodeGroups.get(id);
  if (!job || !group) return;

  const totalSegs = group.segCount;
  const totalData = job.segInfo.fileTotalData;

  // 编码锁：队列 FIFO，保证一次只有一个分卷在编
  let encoding = false;
  const lockQueue = [];

  function makeRelease() {
    return () => {
      encoding = false;
      if (lockQueue.length) {
        const next = lockQueue.shift();
        encoding = true;
        next();
      }
    };
  }

  function acquireLock() {
    if (!encoding) {
      encoding = true;
      return Promise.resolve(makeRelease());
    }
    return new Promise((resolve) =>
      lockQueue.push(() => resolve(makeRelease())),
    );
  }

  for (let i = 0; i < totalSegs; i++) {
    if (job.cancelled) break;

    const segInfo = group.segments[i];

    // 等待该分卷的请求到达（带超时兜底）
    const segWaitThresh = Date.now() + 30000;
    while (!group.pending[i]) {
      if (job.cancelled || Date.now() > segWaitThresh) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    if (!group.pending[i]) {
      console.error("分卷请求超时 segID=" + segInfo.segID);
      break;
    }

    // completedBefore = 该分卷之前已完成的数据量（前缀和 O(1)）
    const completedBefore = group.prefixSum
      ? group.prefixSum[segInfo.segID] || 0
      : 0;

    // 创建流，编码在 start() 中通过 acquireLock 串行化
    const stream = new ReadableStream({
      async start(controller) {
        const release = await acquireLock();
        try {
          const push = (d) => controller.enqueue(d);
          const closeStream = () => {
            try {
              controller.close();
            } catch {}
          };
          const isCancelled = () => job.cancelled;

          const reportProgress = (fraction) => {
            if (totalData <= 0) return;
            const overall =
              (completedBefore + fraction * segInfo.dataSize) / totalData;
            const pct = Math.min(100, Math.round(overall * 100));
            if (pct !== (job.progress || 0)) {
              job.progress = pct;
              postToClients({
                type: "job-progress",
                jobId: id,
                progress: pct,
                total: totalData,
                done: Math.round(overall * totalData),
                currentFile:
                  "[" + (i + 1) + "/" + totalSegs + "] " + segInfo.type,
              });
            }
          };

          if (isCancelled()) {
            controller.error(new Error("已取消"));
            return;
          }

          if (segInfo.segID === 0) {
            await encodeIndexSegment(segInfo, job, push, closeStream, {
              onProgress: reportProgress,
              isCancelled,
            });
          } else {
            await encodeDataSegment(segInfo, job, push, closeStream, {
              onProgress: reportProgress,
              isCancelled,
            });
          }

          // 编码函数可能因取消提前返回（不抛异常），检测后错误终止流
          if (isCancelled()) {
            controller.error(new Error("已取消"));
          }
        } catch (e) {
          controller.error(e);
          console.error("编码分卷失败", segInfo.segID, e);
        } finally {
          release();
        }
      },
      cancel() {
        job.cancelled = true;
      },
    });

    // 立即 resolve，让所有分卷同时拿到 stream
    group.pending[i](stream);

    // 更新主 job 进度
    job.segCompleted = (job.segCompleted || 0) + 1;
    const segPct = Math.round((job.segCompleted / totalSegs) * 100);
    job.progress = Math.max(job.progress || 0, segPct);
    postToClients({
      type: "job-progress",
      jobId: id,
      progress: job.progress,
    });
  }

  // 全部完成
  if (!job.cancelled) {
    job.status = "done";
    job.progress = 100;
    postToClients({ type: "job-done", jobId: id, kind: "encode" });
  } else {
    job.status = "cancelled";
  }

  // 清理：未完成的分卷请求 resolve 为 500（防止浏览器挂起等待）
  for (let j = 0; j < group.pending.length; j++) {
    if (typeof group.pending[j] === "function") {
      group.pending[j](new Response("编码终止", { status: 500 }));
    }
  }

  pendingEncodeGroups.delete(id);
}

/**
 * F2P6 解码流式响应 — 被 /file/<hash>/<filename> 调用
 */
async function serveF2P6DecodeStream(id, idx) {
  const group = pendingF2P6DecodeGroups.get(id);
  if (!group) return new Response("任务不存在", { status: 404 });

  const entry = group.entries[idx];
  if (!entry) return new Response("索引无效", { status: 400 });

  group.dispatched = (group.dispatched || 0) + 1;
  if (group.dispatched >= group.entries.length)
    pendingF2P6DecodeGroups.delete(id);

  const keyRaw =
    group.keyRaw instanceof Uint8Array
      ? group.keyRaw
      : new Uint8Array(group.keyRaw);
  const key = await crypto.subtle.importKey(
    "raw",
    keyRaw,
    { name: "AES-CTR" },
    false,
    ["decrypt"],
  );

  const indexBmpMeta = await readBmpHeader(group.indexBlob);
  const indexInfo = {
    key,
    entries: group.entries,
    dataInIndex: group.dataInIndex,
    indexDataPayloadOffset: group.indexDataPayloadOffset,
    bmpMeta: indexBmpMeta,
    segSalt: new Uint8Array(group.indexSegSalt),
  };

  const dataSegments = [];
  const segInfos = group.dataSegments || [];
  for (const seg of segInfos) {
    const bmpMeta = await readBmpHeader(seg.blob);
    dataSegments.push({
      segID: seg.segID,
      segSalt: new Uint8Array(seg.segSalt),
      dataSize: seg.dataSize,
      dataOffset: seg.dataOffset,
      bmpMeta,
    });
  }

  const fileSize = entry.size;
  const headers = attachHdr();
  if (fileSize) headers.set("Content-Length", String(fileSize));

  const gjId = id + "_" + idx;
  const job = {
    kind: "decode",
    status: "running",
    progress: 0,
    currentFile: entry.name,
    label: entry.name,
    totalFiles: 1,
  };
  jobs.set(gjId, job);
  postToClients({ type: "job-new", jobId: gjId, ...job });

  const CHUNK = (group.chunkSize || 64) * 1024;
  const stream = new ReadableStream({
    async start(controller) {
      postToClients({ type: "job-start", jobId: gjId });
      try {
        let offset = 0;
        while (offset < fileSize && !job.cancelled) {
          const take = Math.min(CHUNK, fileSize - offset);
          const chunk = await extractFileDataRange(
            indexInfo,
            dataSegments,
            idx,
            offset,
            take,
          );
          if (job.cancelled) break;
          if (chunk.length === 0) break;
          controller.enqueue(chunk);
          offset += chunk.length;
          const pct = Math.min(100, Math.round((offset / fileSize) * 100));
          if (pct !== job.progress) {
            job.progress = pct;
            postToClients({
              type: "job-progress",
              jobId: gjId,
              progress: pct,
              done: offset,
              total: fileSize,
              currentFile: entry.name,
            });
          }
        }
        if (!job.cancelled) {
          controller.close();
          job.status = "done";
          job.progress = 100;
          postToClients({
            type: "job-done",
            jobId: gjId,
            kind: "decode",
            fileName: entry.name,
            size: fileSize,
          });
        }
      } catch (e) {
        controller.error(e);
        job.status = "error";
        job.error = e.message;
        postToClients({ type: "job-error", jobId: gjId, error: e.message });
      }
    },
    cancel() {
      job.cancelled = true;
      job.status = "cancelled";
      postToClients({ type: "job-update", jobId: gjId, status: "cancelled" });
    },
  });

  return new Response(stream, { headers });
}
