// ═══════════════════════════════════════════════
// F2P Service Worker — 任务执行 + 流式下载
// ═══════════════════════════════════════════════

import {
  fmt,
  deriveEncKey,
  aesEncrypt,
  aesDecrypt,
  readChunk,
  buildBMPStream,
  readBmpHeader,
  readPayload,
  decMetaStream,
} from "./lib/f2p-core.js";
import {
  precomputeLayout,
} from "./lib/tiff-common.js";
import {
  buildHeader,
  buildIFD,
  buildIndexPixels,
} from "./lib/tiff-encode.js";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);

const jobs = new Map();
const pendingStreams = new Map(); // jobId -> { push, close }
const pendingDecodeStreams = new Map(); // jobId -> { bmpFile, key, offset, size, nonce, name }
const pendingDecodeGroups = new Map(); // groupId -> { files: [{offset,size,nonce,name}], key, chunkSize }
let jobIdCounter = 0;

// ── 通知点击 ──

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((cs) => {
        if (cs.length > 0) {
          cs[0].focus();
          cs[0].postMessage({ type: "notification-open", jobId: data.jobId });
        } else self.clients.openWindow("/");
      }),
  );
});

// ── 消息处理 ──

self.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || !msg.type) return;
  if (msg.type === "ping") return;
  switch (msg.type) {
    case "encode":
      event.waitUntil(runEncode(event, msg));
      break;
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
      event.waitUntil(handleDecodeStreamPrepare(event, msg));
      break;
    case "encode-stream-prepare":
      handleEncodeStreamPrepare(event, msg);
      break;
    case "decode-group":
      event.waitUntil(handleDecodeGroup(event, msg));
      break;
  }
});

// ── 流式下载拦截 ──

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // 统一流式下载：POST /dl
  // 请求体表单含 jobId + 可选 size/name
  // encode job → pendingStreams 推送 BMP 像素
  // decode job → pendingDecodeStreams 从 BMP 读取并解密
  if (url.pathname === "/dl" && event.request.method === "POST") {
    event.respondWith(
      (async () => {
        const fd = await event.request.formData();
        const p = Object.fromEntries(fd.entries());
        const jobId = p.id;
        if (!jobId) return new Response("缺少 id", { status: 400 });

        // 编码流式下载
        const encJob = pendingStreams.get(jobId);
        if (encJob) {
          const fileName =
            p.name ||
            encJob.name ||
            (jobs.get(jobId) || {}).filename ||
            "F2P_export.bmp";
          const headers = new Headers({
            "Content-Type": "application/octet-stream; charset=utf-8",
            "Content-Disposition":
              'attachment; filename="' + fileName.replace(/"/g, "_") + '"',
            "Content-Security-Policy": "default-src 'none'",
          });
          if (encJob.size) headers.set("Content-Length", String(encJob.size));
          const stream = new ReadableStream({
            start(c) {
              encJob.push = (d) => c.enqueue(d);
              encJob.close = () => {
                try {
                  c.close();
                } catch {}
              };
            },
            cancel() {
              const j = jobs.get(jobId);
              if (j) j.cancelled = true;
            },
          });
          return new Response(stream, { headers });
        }

        // 解码流式下载
        const decJob = pendingDecodeStreams.get(jobId);
        if (decJob) {
          pendingDecodeStreams.delete(jobId);
          const fileName = decJob.name || "file.bin";

          const job = {
            kind: "decode",
            status: "running",
            progress: 0,
            currentFile: fileName,
            label: fileName,
            totalFiles: 1,
          };
          jobs.set(jobId, job);
          postToClients({ type: "job-new", jobId, ...job });

          const headers = new Headers({
            "Content-Type": "application/octet-stream; charset=utf-8",
            "Content-Disposition": safeContentDisposition(fileName),
          });
          if (decJob.size) headers.set("Content-Length", String(decJob.size));
          const stream = new ReadableStream({
            async start(controller) {
              try {
                let pos = decJob.offset,
                  left = decJob.size,
                  total = decJob.size;
                while (left > 0 && !job.cancelled) {
                  const ck = (decJob.chunkSize || 64) * 1024;
                  const take = Math.min(left, ck);
                  let data;
                  if (decJob.tiff) {
                    data = new Uint8Array(
                      await decJob.bmpFile.slice(pos, pos + take).arrayBuffer(),
                    );
                  } else {
                    const bmp = await readBmpHeader(decJob.bmpFile);
                    data = await readPayload(bmp, pos, take);
                  }
                  if (job.cancelled) break;
                  let out = data;
                  if (decJob.key && decJob.nonce)
                    out = await aesDecrypt(
                      data,
                      decJob.key,
                      decJob.nonce,
                      (decJob.ctrStart || 0) + (pos - decJob.offset) / 16,
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
                      jobId,
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
                    jobId,
                    kind: "decode",
                    filename: fileName,
                    size: total,
                  });
                }
              } catch (e) {
                controller.error(e);
                job.status = "error";
                job.error = e.message;
                postToClients({ type: "job-error", jobId, error: e.message });
              }
            },
            cancel() {
              job.cancelled = true;
              job.status = "cancelled";
              postToClients({ type: "job-update", jobId, status: "cancelled" });
            },
          });
          return new Response(stream, { headers });
        }

        // 分组流式下载（通过 idx 索引 group 列表）
        if (p.idx !== undefined) {
          const group = pendingDecodeGroups.get(jobId);
          if (group) {
            const fi = group.files[parseInt(p.idx)];
            if (fi) {
              group.dispatched = (group.dispatched || 0) + 1;
              if (group.dispatched >= group.files.length)
                pendingDecodeGroups.delete(jobId);
              const fileName = fi.name || "file.bin";
              const gjId = jobId + "_" + p.idx;
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

              const headers = new Headers({
                "Content-Type": "application/octet-stream; charset=utf-8",
                "Content-Disposition": safeContentDisposition(fileName),
              });
              if (fi.size) headers.set("Content-Length", String(fi.size));
              const stream = new ReadableStream({
                async start(controller) {
                  try {
                    let pos = fi.offset,
                      left = fi.size,
                      total = fi.size;
                    while (left > 0 && !job.cancelled) {
                      const ck = (group.chunkSize || 64) * 1024;
                      const take = Math.min(left, ck);
                      let data;
                      if (fi.tiff) {
                        data = new Uint8Array(
                          await group.bmpFile.slice(pos, pos + take).arrayBuffer(),
                        );
                      } else {
                        const bmp = await readBmpHeader(group.bmpFile);
                        data = await readPayload(bmp, pos, take);
                      }
                      if (job.cancelled) break;
                      let out = data;
                      if (group.key && fi.nonce)
                        out = await aesDecrypt(
                          data,
                          group.key,
                          fi.nonce,
                          (fi.ctrStart || 0) + (pos - fi.offset) / 16,
                        );
                      if (job.cancelled) break;
                      controller.enqueue(out);
                      left -= take;
                      pos += take;
                      const done = total - left;
                      const pct = Math.min(
                        100,
                        Math.round((done / total) * 100),
                      );
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
                        filename: fileName,
                        size: total,
                      });
                    }
                  } catch (e) {
                    controller.error(e);
                    job.status = "error";
                    job.error = e.message;
                    postToClients({
                      type: "job-error",
                      jobId: gjId,
                      error: e.message,
                    });
                  }
                },
                cancel() {
                  job.cancelled = true;
                  job.status = "cancelled";
                  postToClients({
                    type: "job-update",
                    jobId: gjId,
                    status: "cancelled",
                  });
                },
              });
              return new Response(stream, { headers });
            }
          }
        }

        return new Response("未找到任务", { status: 404 });
      })(),
    );
  }
});

// ── 解码流式准备 ──

async function handleDecodeStreamPrepare(event, msg) {
  const {
    jobId,
    bmpFile,
    offset,
    size,
    nonce,
    name,
    keyRaw,
    chunkSize = 64,
    ctrStart = 0,
    tiff = false,
  } = msg;
  if (!jobId) return;
  try {
    let key = null;
    if (keyRaw) {
      key = await crypto.subtle.importKey(
        "raw",
        new Uint8Array(keyRaw),
        { name: "AES-CTR" },
        false,
        ["decrypt"],
      );
    }
    pendingDecodeStreams.set(jobId, {
      bmpFile,
      key,
      offset,
      size,
      nonce: nonce ? new Uint8Array(nonce) : null,
      name,
      chunkSize,
      ctrStart,
      tiff,
    });
    if (event.source)
      event.source.postMessage({ type: "decode-stream-ready", jobId, name });
  } catch (e) {
    if (event.source)
      event.source.postMessage({
        type: "decode-stream-error",
        jobId,
        error: e.message,
      });
  }
}

// ── 编码流式准备 ──

function handleEncodeStreamPrepare(event, msg) {
  const { jobId, filename, size } = msg;
  if (!jobId) return;
  pendingStreams.set(jobId, { push: null, close: null, size, name: filename });
  if (event.source)
    event.source.postMessage({
      type: "encode-stream-ready",
      jobId,
      name: filename,
    });
}

// ── 解码分组准备 ──

async function handleDecodeGroup(event, msg) {
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
  try {
    let key = null;
    if (keyRaw) {
      key = await crypto.subtle.importKey(
        "raw",
        new Uint8Array(keyRaw),
        { name: "AES-CTR" },
        false,
        ["decrypt"],
      );
    }
    pendingDecodeGroups.set(id, {
      bmpFile,
      files: files.map((f) => ({
        ...f,
        nonce: f.nonce ? new Uint8Array(f.nonce) : null,
      })),
      key,
      chunkSize: chunkSize || 64,
      dispatched: 0,
    });
    if (event.source)
      event.source.postMessage({ type: "decode-group-ready", id });
  } catch (e) {
    if (event.source)
      event.source.postMessage({
        type: "decode-group-error",
        id,
        error: e.message,
      });
  }
}

// ── 工具 ──

function safeContentDisposition(name) {
  const safe = name.replace(/[\x00-\x1f\\"]/g, "_");
  const latin1 = safe.replace(/[^\x00-\xFF]/g, "_");
  const encoded = encodeURIComponent(safe);
  // RFC 5987: latin fallback + UTF-8 explicit
  return 'attachment; filename="' + latin1 + "\"; filename*=UTF-8''" + encoded;
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

// ── 编码 ──

async function runEncode(event, msg) {
  const { files, password, chunkSize = 64, nameEnc = false, jobId } = msg;
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
    filename: msg.filename || "F2P_export.tif",
  };
  jobs.set(jobId, job);
  postToClients({ type: "job-new", jobId, ...job });

  // 取出预创建的流 controller（页面在发消息前已踢下载）
  const pc = pendingStreams.get(jobId);
  if (!pc) {
    postToClients({ type: "job-error", jobId, error: "下载流不可用" });
    return;
  }
  // POST /dl handler 的 start() 可能在 await formData() 后还没触发
  // 等 push 就绪再继续
  if (!pc.push) {
    await new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        if (pc.push) resolve();
        else if (Date.now() - start > 10000) resolve();
        else setTimeout(check, 5);
      };
      check();
    });
    if (!pc.push) {
      postToClients({ type: "job-error", jobId, error: "下载流超时" });
      return;
    }
  }
  const push = pc.push,
    closeStream = pc.close;
  pendingStreams.delete(jobId);

  try {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const encKey = await deriveEncKey(password, salt, 10000);

    // 预计算布局
    const layout = precomputeLayout(
      files.map((f) => ({ name: f.name, size: f.size })),
    );

    // 加密 magic_check: "F2P4" (salt[0..12], CTR block 0)
    const encMagic = await aesEncrypt(
      new Uint8Array([0x46, 0x32, 0x50, 0x34]),
      encKey,
      salt.subarray(0, 12),
      0,
    );

    // 构建索引像素（含 salt, iter, encMagic, 文件名明文, nonce）
    const fileNames = files.map(f => f.name);
    const { pixels: indexPixels, fileNonces } = buildIndexPixels(
      layout, fileNames, salt, 10000, encMagic);

    // 构建 IFD 块
    const header = buildHeader(layout.H);
    const ifd0 = buildIFD(
      layout.ifdOffsets[0],
      layout.N > 0 ? layout.ifdOffsets[1] : 0,
      layout.idxSide, layout.idxSide,
      layout.stripOffsets[0], layout.idxStripSize);

    const ifdBufs = [];
    for (let i = 0; i < layout.N; i++) {
      const wi = Math.max(1, Math.ceil(Math.sqrt(Math.ceil(layout.S[i] / 4))));
      const nextOff = i + 1 < layout.N ? layout.ifdOffsets[i + 2] : 0;
      const buf = buildIFD(
        layout.ifdOffsets[i + 1], nextOff,
        wi, wi,
        layout.stripOffsets[i + 1], layout.S[i]);
      ifdBufs.push(buf);
    }

    // 流式写入
    push(header);
    push(ifd0);
    push(indexPixels); // IFD#0 strip

    // 写入各文件
    const ck = chunkSize * 1024;
    let totalBytes = 0;
    for (let i = 0; i < layout.N; i++) {
      const f = files[i];
      const nd = fileNonces.subarray(i * 12, (i + 1) * 12);

      push(ifdBufs[i]); // 数据 IFD

      job.currentFile = f.name;
      let pos = 0;
      while (pos < f.size) {
        if (job.cancelled) throw Error("cancel");
        const end = Math.min(pos + ck, f.size);
        const buf = await readChunk(f, pos, end, ck);
        const enc = await aesEncrypt(buf, encKey, nd, pos / 16);
        push(enc);
        pos = end;
        const done = totalBytes + pos;
        const allSizes = layout.fileSizes.reduce((a, b) => a + b, 0);
        const pct = allSizes > 0 ? Math.min(100, (done / allSizes) * 100 | 0) : 100;
        job.progress = pct;
        postToClients({ type: "job-progress", jobId, progress: pct, done, total: allSizes, currentFile: f.name });
      }
      totalBytes += f.size;

      const paddingSize = layout.S[i] - layout.fileSizes[i];
      if (paddingSize > 0) push(new Uint8Array(paddingSize));
    }

    if (job.cancelled) throw Error("cancel");
    closeStream();

    job.status = "done";
    job.progress = 100;
    postToClients({
      type: "job-done",
      jobId,
      kind: "encode",
      filename: job.filename,
      size: layout.totalSize,
    });
    try {
      self.registration.showNotification("F2P 编码完成", {
        body: job.label + " · " + fmt(layout.totalSize),
        icon: "/favicon.png",
        tag: "f2p-" + jobId,
        data: { jobId },
      });
    } catch {}
  } catch (e) {
    try {
      closeStream();
    } catch {}
    if (e.message === "cancel") {
      job.status = "cancelled";
      postToClients({ type: "job-update", jobId, status: "cancelled" });
    } else {
      job.status = "error";
      job.error = e.message;
      console.error(e);
      postToClients({ type: "job-error", jobId, error: e.message });
    }
  }
}
