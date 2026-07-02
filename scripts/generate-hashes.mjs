// 后处理：生成 hashes.json，格式 {"路径": "sha256", ...}
// SW 按此表增量更新缓存，路径不含前导 /

import { readFileSync, writeFileSync, readdirSync } from "fs";
import { createHash } from "crypto";
import { resolve, join } from "path";
import { fileURLToPath } from "url";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");
const distDir = resolve(__dirname, "../dist");

const IGNORE = new Set(["hashes.json"]);
const IGNORE_PATTERN = /\.map$/;

const table = {};

function walk(dir, base) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(full, rel);
    else if (entry.isFile() && !IGNORE.has(rel) && !IGNORE_PATTERN.test(rel)) {
      table[rel] = createHash("sha256")
        .update(readFileSync(full))
        .digest("hex");
    }
  }
}

walk(distDir, "");
writeFileSync(join(distDir, "hashes.json"), JSON.stringify(table), "utf-8");

const count = Object.keys(table).length;
console.log(`🧾 hashes.json generated — ${count} entries`);
for (const [key, hash] of Object.entries(table))
  console.log(`   ${key}  →  ${hash.slice(0, 12)}…`);
