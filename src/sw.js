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
} from "./lib/f2p-core.js";

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
      // 同步设 pendingStreams，让 /dl 拦截能找到
      pendingStreams.set(msg.jobId, {
        push: null,
        close: null,
        size: msg.totalSize,
        name: msg.filename,
      });
      if (event.source)
        event.source.postMessage({
          type: "encode-stream-ready",
          jobId: msg.jobId,
          name: msg.filename,
        });
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
      handleDecodeStreamPrepare(event, msg);
      break;
    case "decode-group":
      handleDecodeGroup(event, msg);
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
          postToClients({ type: "download-started", jobId });
          return new Response(stream, { headers });
        }

        // 解码流式下载
        const decJob = pendingDecodeStreams.get(jobId);
        if (decJob) {
          pendingDecodeStreams.delete(jobId);
          // 等待异步密钥导入
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
                // 预先解析 BMP 头，避免循环内重复解析
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
                  if (decJob.key && decJob.nonce)
                    out = await aesDecrypt(
                      data,
                      decJob.key,
                      decJob.nonce,
                      (pos - decJob.offset) / 16,
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
          postToClients({ type: "download-started", jobId });
          return new Response(stream, { headers });
        }

        // 分组流式下载（通过 idx 索引 group 列表）
        if (p.idx !== undefined) {
          const group = pendingDecodeGroups.get(jobId);
          if (group) {
            // 等待异步密钥导入
            if (group.keyPromise) {
              try {
                group.key = await group.keyPromise;
              } catch (e) {
                return new Response("密钥导入失败", { status: 500 });
              }
            }
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
                    // 预先解析 BMP 头，避免循环内重复解析
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
                      if (group.key && fi.nonce)
                        out = await aesDecrypt(
                          data,
                          group.key,
                          fi.nonce,
                          (pos - fi.offset) / 16,
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
              postToClients({ type: "download-started", jobId: gjId });
              return new Response(stream, { headers });
            }
          }
        }

        return new Response("未找到任务", { status: 404 });
      })(),
    );
  }
});

// ── 解码流式准备（同步设 pending 条目，key 异步导入推迟到 fetch handler）──

function handleDecodeStreamPrepare(event, msg) {
  const {
    jobId,
    bmpFile,
    offset,
    size,
    nonce,
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
    nonce: nonce ? new Uint8Array(nonce) : null,
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
      nonce: f.nonce ? new Uint8Array(f.nonce) : null,
    })),
    keyPromise,
    chunkSize: chunkSize || 64,
    dispatched: 0,
  });

  if (event.source)
    event.source.postMessage({ type: "decode-group-ready", id });
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
    postToClients({ type: "job-error", jobId, error: "下载流不可用" });
    return;
  }
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
    let ms = 32,
      ds = 0; // magic(4) + fileCount(4) + salt(16) + iter(4) + encMagic(4)
    for (const f of files) {
      const nl = new TextEncoder().encode(f.name).length;
      ms += 2 + nl + 8 + 12 + 12;
      ds += f.size;
    }

    const bmp = buildBMPStream(ms + ds, (row) => push(row));
    push(bmp.header);

    bmp.w32(0x46325034); // F2P4
    bmp.w32(files.length);
    // F2P4 无 flags 字节，文件名强制加密
    bmp.wChunk(salt);
    bmp.w32(10000);

    const magicEnc = await aesEncrypt(
      new Uint8Array([0x46, 0x32, 0x50, 0x34]),
      encKey,
      salt.subarray(0, 12),
      0,
    );
    bmp.wChunk(magicEnc);

    const fileNonces = [];
    for (const f of files) {
      const nd = crypto.getRandomValues(new Uint8Array(12));
      const nb = new TextEncoder().encode(f.name);
      const nn = crypto.getRandomValues(new Uint8Array(12));
      const en = await aesEncrypt(nb, encKey, nn, 0);
      bmp.w16(nb.length);
      bmp.wChunk(en);
      bmp.w64(f.size);
      bmp.wChunk(nn);
      bmp.wChunk(nd);
      fileNonces.push(nd);
    }

    const ck = chunkSize * 1024;
    let processed = 0;
    for (let i = 0; i < files.length; i++) {
      const f = files[i],
        nd = fileNonces[i];
      job.currentFile = f.name;
      let pos = 0;
      while (pos < f.size) {
        if (job.cancelled) throw Error("cancel");
        const end = Math.min(pos + ck, f.size);
        const buf = await readChunk(f, pos, end, ck);
        const enc = await aesEncrypt(buf, encKey, nd, pos / 16);
        bmp.wChunk(enc);
        pos = end;
        const done = processed + pos;
        const pct = ds > 0 ? Math.min(100, ((done / ds) * 100) | 0) : 100;
        job.progress = pct;
        postToClients({
          type: "job-progress",
          jobId,
          progress: pct,
          done,
          total: ds,
          currentFile: f.name,
        });
      }
      processed += f.size;
    }

    if (job.cancelled) throw Error("cancel");
    const tail = bmp.pad();
    if (tail && tail.length) push(tail);
    await bmp.flushAll();
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
    try {
      self.registration.showNotification("F2P 编码完成", {
        body: job.label + " · " + fmt(bmp.fs),
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
