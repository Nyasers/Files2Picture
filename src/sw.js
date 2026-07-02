// ═══════════════════════════════════════════════
// F2P Service Worker — 任务执行 + 流式下载 + PWA 缓存
// ═══════════════════════════════════════════════
"use strict";

import {
  deriveEncKey,
  aesEncrypt,
  aesDecrypt,
  readChunk,
  buildBMPStream,
  readBmpHeader,
  readPayload,
} from "./lib/f2p-core.js";
import { precomputeBmp, writeF2P5Header } from "./lib/f2p-encode.js";

// ── PWA 缓存配置 ──
//   每次刷新（/ 和 /index.html）→ 归一化 SWR
//   /assets/ → SWR + 1hr TTL（session 内不重拉，重启后自动刷新）

const CACHE_NAME = "f2p-v1";
const ASSET_TTL = 3600000;

// ── 工具 ──

function assetUrlSet(url) {
  if (!url || typeof url !== "string") return new Set();
  const set = new Set();
  // <script src="..."> 和 <link href="...">
  const srcRe = /<(?:script[^>]*src|link[^>]*href)="([^"]+)"/g;
  let m;
  while ((m = srcRe.exec(url))) set.add(m[1]);
  return set;
}

// 内存时间戳，SW 重启后清空 → 下次访问后台刷新
const cacheTimestamps = new Map();

function cacheTimestampSet(url) {
  const u = new URL(url);
  cacheTimestamps.set(CACHE_NAME + "::" + u.origin + u.pathname, Date.now());
}

function isCachedFresh(url) {
  const u = new URL(url);
  const ts = cacheTimestamps.get(CACHE_NAME + "::" + u.origin + u.pathname);
  return ts && Date.now() - ts < ASSET_TTL;
}

function normalizedUrl(request) {
  const u = new URL(request.url);
  u.search = "";
  u.hash = "";
  return u.href;
}

function isCacheableResponse(res) {
  if (!res || !res.ok) return false;
  const cc = res.headers.get("Cache-Control") || "";
  // 跳过 no-store / private / no-cache
  return !/\b(no-store|private|no-cache)\b/i.test(cc);
}

function isStreamingRoute(pn) {
  return pn === "/files" || pn.startsWith("/file/");
}

function isIndexRoute(pn) {
  return pn === "/" || pn === "/index.html";
}

function isStaticAsset(pn) {
  return pn.startsWith("/assets/");
}

async function staleWhileRevalidate(request, event) {
  const cache = await caches.open(CACHE_NAME);
  const normUrl = normalizedUrl(request);
  const cached = await cache.match(normUrl);
  if (cached) {
    if (isCachedFresh(request.url)) return cached;
    const updatePromise = fetch(request)
      .then((res) => {
        if (isCacheableResponse(res))
          return cache
            .put(normUrl, res.clone())
            .then(() => cacheTimestampSet(request.url));
      })
      .catch(() => {});
    event.waitUntil(updatePromise);
    return cached;
  }
  try {
    const res = await fetch(request);
    if (isCacheableResponse(res)) {
      const putPromise = cache.put(normUrl, res.clone());
      event.waitUntil(putPromise.then(() => cacheTimestampSet(request.url)));
    }
    return res;
  } catch {
    return new Response("Offline", {
      status: 503,
      headers: { "Content-Type": "text/plain" },
    });
  }
}

async function serveIndexFallback(request, event) {
  const url = new URL(request.url);
  const indexUrl = new URL("/", url.origin).href;
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(indexUrl);
  if (cached) {
    const updatePromise = fetch(indexUrl)
      .then((r) => isCacheableResponse(r) && cache.put(indexUrl, r.clone()))
      .catch(() => {});
    event.waitUntil(updatePromise);
    return cached;
  }
  try {
    const res = await fetch(indexUrl);
    if (isCacheableResponse(res))
      event.waitUntil(cache.put(indexUrl, res.clone()));
    return res;
  } catch {
    return new Response("Offline", {
      status: 503,
      headers: { "Content-Type": "text/html" },
    });
  }
}

// ── 原有任务执行 ──

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // ① 拉新 index，读 body 但不缓存——先提取新 hash 的资源 URL
      Promise.allSettled(
        ["/"].map((url) =>
          fetch(url)
            .then((res) => {
              if (!res.ok) return;
              // clone 一份用于后续缓存，body 读文本提取资源 URL
              const clone = res.clone();
              return res.text().then((html) => {
                const urls = [...assetUrlSet(html)];
                // ② 新 JS/CSS 先全部入缓存
                return Promise.allSettled(
                  urls.map((u) =>
                    fetch(u)
                      .then((r) => {
                        if (isCacheableResponse(r)) return cache.put(u, r);
                      })
                      .catch(() => {}),
                  ),
                ).then(() => {
                  // ③ 资源就绪，写回缓存的 clone
                  return cache.put(url, clone);
                });
              });
            })
            .catch(() => {}),
        ),
      )
        // ④ 重验证旧缓存条目（旧 hash fetch 失败就丢弃）
        .then(() =>
          cache.keys().then((requests) =>
            Promise.allSettled(
              requests.map((req) =>
                fetch(req)
                  .then((res) => {
                    if (isCacheableResponse(res)) return cache.put(req, res);
                  })
                  .catch(() => cache.delete(req)),
              ),
            ),
          ),
        ),
    ),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)),
          ),
        ),
    ]).then(() => {
      // 通知所有页面：新 SW 已激活，缓存已刷新
      self.clients.matchAll().then((cs) => {
        for (const c of cs) c.postMessage({ type: "sw-updated" });
      });
    }),
  );
});

const jobs = new Map();
const pendingStreams = new Map(); // jobId -> { push, close }
const pendingDecodeStreams = new Map(); // jobId -> { bmpFile, key, offset, size, counter(16B), bits, name }
const pendingDecodeGroups = new Map(); // groupId -> { files: [{offset,size,counter,bits,name}], key, chunkSize }
const fileRoutes = new Map(); // hash -> { id, idx }
let jobIdCounter = 0;

// ── 消息处理 ──

self.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || !msg.type) return;
  if (msg.type === "ping") return;
  switch (msg.type) {
    case "encode": {
      // 同步设 pendingStreams，让 /dl 拦截能找到
      let pushReady;
      const pushReadyPromise = new Promise((r) => {
        pushReady = r;
      });
      pendingStreams.set(msg.jobId, {
        push: null,
        close: null,
        size: msg.totalSize,
        name: msg.filename,
        pushReady,
      });
      if (event.source)
        event.source.postMessage({
          type: "encode-stream-ready",
          jobId: msg.jobId,
          name: msg.filename,
        });
      event.waitUntil(runEncode(event, msg, pushReadyPromise));
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
  }
});

// ── 流式下载拦截 + PWA 缓存 ──

self.addEventListener("fetch", async (event) => {
  const url = new URL(event.request.url);

  // ════════════════════════════════════════
  // 原有流式下载逻辑（保持不变）
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

        // 分组
        const group = pendingDecodeGroups.get(id);
        if (!group) return new Response("未找到分组", { status: 404 });
        const i = parseInt(idx);
        if (isNaN(i) || !group.files[i])
          return new Response("索引无效", { status: 400 });
        const fileName = group.files[i].name || "file.bin";
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

        if (route.idx !== undefined)
          return serveGroupStream(route.id, route.idx);
        return serveStream(route.id);
      })(),
    );
    return;
  }

  // ════════════════════════════════════════
  // PWA 缓存：三级策略
  // ════════════════════════════════════════

  const pn = url.pathname;
  if (event.request.method === "GET" && !isStreamingRoute(pn)) {
    if (isIndexRoute(pn)) {
      // / 和 /index.html 归一化 SWR
      event.respondWith(serveIndexFallback(event.request, event));
    } else if (isStaticAsset(pn)) {
      // /assets/ → SWR + 1hr TTL（session 内不重拉，重启后自动刷新）
      event.respondWith(staleWhileRevalidate(event.request, event));
    }
  }
  // 其余请求（外部资源等）走默认浏览器行为
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

// ── 编码 ──

async function runEncode(event, msg, pushReadyPromise) {
  const { files, password, chunkSize = 64, jobId } = msg;
  if (!jobId) return;
  const job = {
    kind: "encode",
    status: "running",
    progress: 0,
    cancelled: false,
    fileNames: files.map((f) => f.name),
    totalFiles: files.length,
    currentFile: "",
    label: files.length + " 个文件编码中…",
    filename: msg.filename || "F2P_export.bmp",
  };
  jobs.set(jobId, job);
  postToClients({ type: "job-new", jobId, ...job });

  const pc = pendingStreams.get(jobId);
  if (!pc) {
    pendingStreams.delete(jobId);
    postToClients({ type: "job-error", jobId, error: "下载流不可用" });
    return;
  }
  // 等 ReadableStream 的 start 回调设 push
  await Promise.race([
    pushReadyPromise,
    new Promise((resolve) => setTimeout(resolve, 1e4)),
  ]);
  if (!pc.push) {
    pendingStreams.delete(jobId);
    postToClients({ type: "job-error", jobId, error: "下载流超时" });
    return;
  }
  const push = pc.push,
    closeStream = pc.close;
  pendingStreams.delete(jobId);

  try {
    postToClients({ type: "job-start", jobId });
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const encKey = await deriveEncKey(password, salt, 10000);

    // 使用 F2P5 编码器模块计算布局（统一尺寸计算路径）
    const layout = precomputeBmp(
      files.map((f) => ({ name: f.name, size: f.size })),
    );
    const bmp = buildBMPStream(layout.ms + layout.ds, (row) => push(row));
    push(bmp.header);

    // 生成每文件的 name/data counter
    const fileCounters = files.map(() => ({
      name: crypto.getRandomValues(new Uint8Array(16)),
      data: crypto.getRandomValues(new Uint8Array(16)),
    }));

    // 通过编码器统一入口写元数据头
    await writeF2P5Header(bmp, salt, encKey, files, fileCounters);
    const fileCtrs = fileCounters.map((fc) => fc.data);

    const ck = chunkSize * 1024;
    let processed = 0;
    for (let i = 0; i < files.length; i++) {
      const f = files[i],
        dc = fileCtrs[i];
      job.currentFile = "[" + (i + 1) + "/" + files.length + "] " + f.name;
      let pos = 0;
      while (pos < f.size) {
        if (job.cancelled) throw Error("cancel");
        const end = Math.min(pos + ck, f.size);
        const buf = await readChunk(f, pos, end, ck);
        const enc = await aesEncrypt(buf, encKey, dc, pos / 16, 128);
        bmp.wChunk(enc);
        pos = end;
        const done = processed + pos;
        const totalData = layout.ds;
        const pct =
          totalData > 0 ? Math.min(100, ((done / totalData) * 100) | 0) : 100;
        job.progress = pct;
        postToClients({
          type: "job-progress",
          jobId,
          progress: pct,
          done,
          total: totalData,
          currentFile: "[" + (i + 1) + "/" + files.length + "] " + f.name,
        });
      }
      processed += f.size;
    }

    if (job.cancelled) throw Error("cancel");
    const tail = bmp.pad();
    await bmp.flushAll();
    if (tail && tail.length) push(tail);
    closeStream();

    job.status = "done";
    job.progress = 100;
    postToClients({
      type: "job-done",
      jobId,
      kind: "encode",
      filename: job.filename,
      size: bmp.fs,
    });
  } catch (e) {
    try {
      closeStream();
    } catch {}
    pendingStreams.delete(jobId);
    if (e.message === "cancel") {
      jobs.delete(jobId);
      job.status = "cancelled";
      postToClients({ type: "job-update", jobId, status: "cancelled" });
    } else {
      jobs.delete(jobId);
      job.status = "error";
      job.error = e.message;
      console.error(e);
      postToClients({ type: "job-error", jobId, error: e.message });
    }
  }
}
