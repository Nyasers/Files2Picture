// build.js — Rspack 构建 + HTML 后处理压缩
const rspack = require("@rspack/core");
const config = require("./rspack.config.cjs");
const { minify: minHTML } = require("html-minifier-terser");
const fs = require("fs");
const path = require("path");

const dist = path.resolve(__dirname, "dist");

async function main() {
  // ── 1. Rspack 构建 ──
  const compiler = rspack(config);
  const stats = await new Promise((resolve, reject) => {
    compiler.run((err, stats) => {
      compiler.close(() => {
        if (err) reject(err);
        else resolve(stats);
      });
    });
  });

  const info = stats.toJson({
    all: false,
    assets: true,
    errors: true,
    warnings: true,
  });
  if (stats.hasErrors()) {
    for (const e of info.errors) console.error("❌", e.message);
    process.exit(1);
  }
  for (const w of info.warnings || []) console.warn("⚠️", w.message);

  // ── 2. HTML 后处理压缩 ──
  const htmlPath = path.join(dist, "index.html");
  let html = fs.readFileSync(htmlPath, "utf8");

  // 跳过已经被 HtmlRspackPlugin minify 的 head 部分，整体再过一遍
  const htmlMin = await minHTML(html, {
    collapseWhitespace: true,
    removeComments: true,
    minifyCSS: true,
    minifyJS: false,
    removeAttributeQuotes: true,
    collapseBooleanAttributes: true,
    removeRedundantAttributes: true,
    removeEmptyAttributes: true,
  });

  fs.writeFileSync(htmlPath, htmlMin, "utf8");

  // ── mitm 产物压缩 ──
  const mitmPath = path.join(dist, "mitm.html");
  const mitmSrc = fs.readFileSync(mitmPath, "utf8");
  const mitmMin = await minHTML(mitmSrc, {
    collapseWhitespace: true,
    removeComments: true,
    minifyCSS: true,
    minifyJS: true,
    removeAttributeQuotes: true,
    collapseBooleanAttributes: true,
    removeRedundantAttributes: true,
    removeEmptyAttributes: true,
  });
  fs.writeFileSync(mitmPath, mitmMin, "utf8");

  const swPath = path.join(dist, "sw.js");
  let swSrc = fs.readFileSync(swPath, "utf8");
  swSrc = swSrc
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\n\s*\n/g, "\n");
  fs.writeFileSync(swPath, swSrc, "utf8");

  // ── 4. 报告 ──
  for (const a of info.assets || []) {
    const label = a.emitted ? "→" : "  ";
    console.log(`  ${label} ${a.name}  (${(a.size / 1024).toFixed(1)} KB)`);
  }
  console.log(
    `  HTML post-minify: ${html.length} → ${htmlMin.length} (${((1 - htmlMin.length / html.length) * 100).toFixed(1)}%)`,
  );
  console.log(`  ✅ 构建完成 (${(info.time / 1000).toFixed(1)}s)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
