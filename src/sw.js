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

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);

const jobs = new Map();
const pendingStreams = new Map(); // jobId -> { push, close }
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
    case "decode":
      event.waitUntil(runDecode(event, msg));
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
  }
});

// ── 流式下载拦截 ──

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // 编码流式下载
  const sm = url.pathname.match(/^\/f2p-dl-stream\/([^/]+)$/);
  if (sm) {
    const jobId = sm[1];
    const fileSize = parseInt(url.searchParams.get("size")) || 0;
    const fileName =
      url.searchParams.get("name") ||
      (jobs.get(jobId) || {}).filename ||
      "F2P_export.bmp";
    const headers = new Headers({
      "Content-Type": "application/octet-stream; charset=utf-8",
      "Content-Disposition":
        'attachment; filename="' + fileName.replace(/"/g, "_") + '"',
      "Content-Security-Policy": "default-src 'none'",
    });
    if (fileSize) headers.set("Content-Length", String(fileSize));
    const stream = new ReadableStream({
      start(c) {
        pendingStreams.set(jobId, {
          push: (d) => c.enqueue(d),
          close: () => {
            try {
              c.close();
            } catch {}
          },
        });
      },
      cancel() {
        pendingStreams.delete(jobId);
        const j = jobs.get(jobId);
        if (j) j.cancelled = true;
      },
    });
    event.respondWith(new Response(stream, { headers }));
    return;
  }

  // 解码下载（POST：页面带参数直接请求，SW 从 BMP 读取并解密后流式返回）
  const dm = url.pathname.match(/^\/f2p-dl\/([^/]+)$/);
  if (!dm) return;

  if (event.request.method === "POST") {
    event.respondWith(handleDecodePost(event));
    return;
  }

  event.respondWith(new Response("不支持的请求方式", { status: 405 }));
});

async function handleDecodePost(event) {
  try {
    const fd = await event.request.formData();
    const bmpFile = fd.get("bmp");
    const keyRaw = fd.get("key");
    const offset = parseInt(fd.get("offset")) || 0;
    const size = parseInt(fd.get("size")) || 0;
    const nonceRaw = fd.get("nonce");
    const name = fd.get("name") || "file.bin";

    if (!bmpFile || !size) return new Response("参数不足", { status: 400 });

    const bmp = await readBmpHeader(bmpFile);
    let key = null,
      nonce = null;
    if (keyRaw && nonceRaw) {
      const ab = await keyRaw.arrayBuffer();
      key = await crypto.subtle.importKey(
        "raw",
        ab,
        { name: "AES-CTR" },
        false,
        ["decrypt"],
      );
      nonce = new Uint8Array(await nonceRaw.arrayBuffer());
    }

    const headers = new Headers({
      "Content-Type": "application/octet-stream; charset=utf-8",
      "Content-Disposition":
        'attachment; filename="' + name.replace(/"/g, "_") + '"',
    });

    const stream = new ReadableStream({
      async start(controller) {
        try {
          let pos = offset,
            left = size;
          while (left > 0) {
            const take = Math.min(left, 65536);
            const data = await readPayload(bmp, pos, take);
            let out = data;
            if (key && nonce)
              out = await aesDecrypt(data, key, nonce, (pos - offset) / 16);
            controller.enqueue(out);
            left -= take;
            pos += take;
          }
          controller.close();
        } catch (e) {
          controller.error(e);
        }
      },
    });

    return new Response(stream, { headers });
  } catch (e) {
    return new Response(e.message, { status: 500 });
  }
}

// ── 工具 ──

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
  if (j && (j.status === "done" || j.status === "error")) jobs.delete(id);
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
    filename: msg.filename || "F2P_export.bmp",
  };
  jobs.set(jobId, job);
  postToClients({ type: "job-new", jobId, ...job });

  // 取出预创建的流 controller（页面在发消息前已踢下载）
  const pc = pendingStreams.get(jobId);
  if (!pc) {
    postToClients({ type: "job-error", jobId, error: "下载流不可用" });
    return;
  }
  const push = pc.push,
    closeStream = pc.close;
  pendingStreams.delete(jobId);

  try {
    const flags = nameEnc ? 1 : 0;
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const encKey = await deriveEncKey(password, salt, 10000);
    let ms = 33,
      ds = 0;
    for (const f of files) {
      const nl = new TextEncoder().encode(f.name).length;
      ms += 2 + nl + 8 + 12 + (flags ? 12 : 0);
      ds += f.size;
    }

    const bmp = buildBMPStream(ms + ds, (row) => push(row));
    const { w, h, fs } = bmp;
    push(bmp.header);

    bmp.w32(0x46325032);
    bmp.w32(files.length);
    bmp.w8(flags);
    bmp.wChunk(salt);
    bmp.w32(10000);

    const magicEnc = await aesEncrypt(
      new Uint8Array([0x46, 0x32, 0x50, 0x32]),
      encKey,
      salt.subarray(0, 12),
      0,
    );
    bmp.wChunk(magicEnc);

    const fileNonces = [];
    for (const f of files) {
      const nd = crypto.getRandomValues(new Uint8Array(12));
      const nb = new TextEncoder().encode(f.name);
      if (flags) {
        const nn = crypto.getRandomValues(new Uint8Array(12));
        const en = await aesEncrypt(nb, encKey, nn, 0);
        bmp.w16(nb.length);
        bmp.wChunk(en);
        bmp.w64(f.size);
        bmp.wChunk(nn);
        bmp.wChunk(nd);
      } else {
        bmp.w16(nb.length);
        bmp.wChunk(nb);
        bmp.w64(f.size);
        bmp.wChunk(nd);
      }
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
        const pct = Math.min(100, ((done / ds) * 100) | 0);
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
    bmp.pad();
    await bmp.flushAll();
    closeStream();

    job.status = "done";
    job.progress = 100;
    postToClients({
      type: "job-done",
      jobId,
      kind: "encode",
      filename: job.filename,
      size: fs,
    });
    try {
      self.registration.showNotification("F2P 编码完成", {
        body: job.label + " · " + fmt(fs),
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

// ── 解码（仅准备，不下发任务进度） ──

async function runDecode(event, msg) {
  const {
    bmpFile,
    fileIndex,
    fileName,
    fileSize,
    dataStart,
    nonceData,
    rawKey,
    jobId,
  } = msg;
  if (!jobId) return;
  try {
    const bmp = await readBmpHeader(bmpFile);
    const hdr = await readPayload(bmp, 0, 8);
    const marker = (hdr[0] << 24) | (hdr[1] << 16) | (hdr[2] << 8) | hdr[3];
    const isEnc = (marker & 0xffffff00) === 0x46325000 && (marker & 0xff) > 1;
    let key = null;

    if (isEnc) {
      if (!rawKey) throw Error("缺少加密密钥");
      key = await crypto.subtle.importKey(
        "raw",
        rawKey,
        { name: "AES-CTR" },
        false,
        ["decrypt"],
      );
      // magic check 已在页面完成，SW 直接信任
    }

    const nd = nonceData ? new Uint8Array(nonceData) : null;
    jobs.set(jobId, {
      kind: "decode",
      status: "ready",
      bmpMeta: bmp,
      dataStart,
      key,
      nd,
      fileList: [{ name: fileName, size: fileSize, offset: 0, nonceData: nd }],
      cancelled: false,
    });
    // 通知页面可以踢下载了
    postToClients({ type: "decode-ready", jobId });
  } catch (e) {
    postToClients({ type: "job-error", jobId, error: e.message });
  }
}
