// ═══════════════════════════════════════════════
// F2P 编码入口 — 各版本编码器统一导出
// ═══════════════════════════════════════════════
"use strict";

// F2P6
export {
  precomputeSegments,
  writeIndexPayload,
  writeDataPayload,
  encodeIndexSegment,
  encodeDataSegment,
  readFileDataRange,
  buildFileEntriesFromFiles,
  payloadForTarget,
  INDEX_HEADER_SIZE,
  DATA_HEADER_SIZE,
} from "./coders/f2p6-encode.js";
