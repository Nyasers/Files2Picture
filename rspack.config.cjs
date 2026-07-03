// rspack.config.cjs — 双入口：页面（main）+ SW（f2p-sw）
// SW 依赖页面，顺序编译避免多 compiler 共享 output 的冲突

const rspack = require("@rspack/core");
const path = require("path");
const { execSync } = require("child_process");
const isDev = process.env.NODE_ENV === "development";
const distDir = path.resolve(__dirname, "dist");

/** @type {import('@rspack/core').Configuration[]} */
module.exports = [
  // ── 页面入口 ──
  {
    name: "page",
    mode: isDev ? "development" : "production",
    context: __dirname,
    entry: "./src/main.js",
    target: "web",
    output: {
      path: distDir,
      filename: "main.js",
      clean: true,
    },
    devServer: {
      port: 3000,
      hot: false,
      liveReload: false,
      open: false,
      static: { directory: distDir },
    },
    module: {
      rules: [
        {
          test: /\.css$/,
          use: [rspack.CssExtractRspackPlugin.loader, "css-loader"],
          type: "javascript/auto",
        },
      ],
    },
    plugins: [
      new rspack.HtmlRspackPlugin({
        template: "./src/index.html",
        inject: true,
      }),
      new rspack.CssExtractRspackPlugin({
        filename: "style.css",
      }),
      new rspack.CopyRspackPlugin({
        patterns: [
          {
            from: path.resolve(__dirname, "src/assets"),
          },
        ],
      }),
    ],
    optimization: isDev
      ? { minimize: false }
      : {
          minimize: true,
          minimizer: [
            new rspack.SwcJsMinimizerRspackPlugin({
              minimizerOptions: {
                compress: { passes: 2 },
                mangle: true,
                format: { comments: false },
              },
            }),
            new rspack.LightningCssMinimizerRspackPlugin({
              minimizerOptions: { errorRecovery: false },
            }),
          ],
        },
  },

  // ── Service Worker 入口（等页面编译完再跑） ──
  {
    name: "sw",
    dependencies: ["page"],
    mode: isDev ? "development" : "production",
    context: __dirname,
    entry: "./src/sw.js",
    target: "webworker",
    output: {
      path: distDir,
      filename: "sw.js",
    },
    optimization: isDev ? { minimize: false } : { minimize: true },
    plugins: [
      {
        apply(compiler) {
          compiler.hooks.afterDone.tap("GenerateHashes", () => {
            const dir = __dirname.replace(/\\/g, "/");
            try {
              execSync(`node "${dir}/scripts/minify-html.mjs"`, {
                stdio: "inherit",
                cwd: __dirname,
              });
            } catch {}
            try {
              execSync(`node "${dir}/scripts/generate-hashes.mjs"`, {
                stdio: "inherit",
                cwd: __dirname,
              });
            } catch {}
          });
        },
      },
    ],
  },
];
