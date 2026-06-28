// build.js — 自动检测：外链压缩内嵌、内嵌压缩、CDN 保留
const { minify: minJS } = require("terser");
const CleanCSS = require("clean-css");
const { minify: minHTML } = require("html-minifier-terser");
const fs = require("fs");
const path = require("path");

const dir = __dirname;
const srcDir = path.join(dir, "src");

function isURL(s) {
  return /^https?:\/\//.test(s);
}
function load(file) {
  return fs.readFileSync(path.join(srcDir, file), "utf8");
}
function pct(a, b) {
  return ((1 - b.length / a.length) * 100).toFixed(1) + "%";
}
const TERSER_OPTS = {
  compress: { passes: 2 },
  mangle: { toplevel: true },
  output: { comments: false },
};

async function main() {
  let html = load("index.html");

  // ── 1. 外链 CSS（<link rel="stylesheet" href="...">）→ <style> ──
  for (const m of html.matchAll(
    /<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"[^>]*>/gi,
  )) {
    const tag = m[0],
      file = m[1];
    if (isURL(file)) {
      console.log(`  CSS: ${file}  (CDN，保留)`);
      continue;
    }
    const src = load(file);
    const r = new CleanCSS({ level: 2 }).minify(src);
    if (r.errors.length) throw r.errors[0];
    html = html.replace(tag, `<style>${r.styles}</style>`);
    console.log(
      `  CSS: ${file}  ${src.length} → ${r.styles.length} (${pct(src, r.styles)})`,
    );
  }

  // ── 2. 外链 JS（<script src="...">）→ <script> ──
  for (const m of html.matchAll(
    /<script\b[^>]*\bsrc="([^"]+)"[^>]*>\s*<\/script>/gi,
  )) {
    const tag = m[0],
      file = m[1];
    if (isURL(file)) {
      console.log(`  JS:  ${file}  (CDN，保留)`);
      continue;
    }
    const src = load(file);
    const r = await minJS(src, TERSER_OPTS);
    if (r.error) throw r.error;
    html = html.replace(tag, `<script>${r.code}</script>`);
    console.log(
      `  JS:  ${file}  ${src.length} → ${r.code.length} (${pct(src, r.code)})`,
    );
  }

  // ── 3. 内嵌 <style>（不含已被替换的）──
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    const tag = m[0],
      body = m[1];
    if (!body.trim() || !/\n/.test(body)) continue;
    const r = new CleanCSS({ level: 2 }).minify(body);
    html = html.replace(tag, `<style>${r.styles}</style>`);
    console.log(
      `  CSS: [inline]  ${body.length} → ${r.styles.length} (${pct(body, r.styles)})`,
    );
  }

  // ── 4. 内嵌 <script>（不含 src，不含已被 terser 压缩的）──
  for (const m of html.matchAll(
    /<script\b(?![\s\S]*?\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi,
  )) {
    const tag = m[0],
      body = m[2];
    if (!body.trim() || !/\n/.test(body)) continue;
    const r = await minJS(body, { ...TERSER_OPTS, mangle: false });
    if (r.error) throw r.error;
    html = html.replace(tag, `<script>${r.code}</script>`);
    console.log(
      `  JS:  [inline]  ${body.length} → ${r.code.length} (${pct(body, r.code)})`,
    );
  }

  // ── 5. 压缩 HTML ──
  const htmlMin = await minHTML(html, {
    collapseWhitespace: true,
    removeComments: true,
    minifyCSS: false,
    minifyJS: false,
  });
  console.log(
    `  HTML: ${html.length} → ${htmlMin.length} (${pct(html, htmlMin)})`,
  );

  const outDir = path.join(dir, "dist");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "index.html");
  fs.writeFileSync(outPath, htmlMin, "utf8");
  console.log(`  → ${outPath}`);

  // ── 6. 复制 favicon ──
  const srcIcon = path.join(srcDir, "favicon.png");
  if (fs.existsSync(srcIcon)) {
    const dstIcon = path.join(outDir, "favicon.png");
    fs.copyFileSync(srcIcon, dstIcon);
    console.log(`  → ${dstIcon}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
