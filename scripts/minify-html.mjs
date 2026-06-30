// 后处理：压缩 dist/index.html
// HtmlRspackPlugin 不负责压缩，全权交由 html-minifier-terser 处理

import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { minify } from "html-minifier-terser";

const __dirname = dirname(fileURLToPath(import.meta.url));
const htmlPath = resolve(__dirname, "../dist/index.html");

const html = readFileSync(htmlPath, "utf-8");

const result = await minify(html, {
  collapseWhitespace: true,
  removeComments: true,
  removeRedundantAttributes: true,
  removeScriptTypeAttributes: true,
  removeStyleLinkTypeAttributes: true,
  useShortDoctype: true,
  minifyCSS: true,
  minifyJS: true,
  decodeEntities: true,
});

writeFileSync(htmlPath, result, "utf-8");
console.log("✅ dist/index.html minified");
