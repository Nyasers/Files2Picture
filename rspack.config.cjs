// rspack.config.cjs — 双入口：页面（main）+ SW（f2p-sw）
// SW 依赖页面，顺序编译避免多 compiler 共享 output 的冲突

const rspack = require("@rspack/core");
const path = require("path");

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
      filename: isDev ? "main.js" : "main.[contenthash:8].js",
      clean: true,
    },
    devServer: {
      port: 3000,
      hot: true,
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
        favicon: "./src/favicon.png",
        inject: true,
        minify: !isDev,
      }),
      new rspack.CssExtractRspackPlugin({
        filename: isDev ? "style.css" : "style.[contenthash:8].css",
      }),
      new rspack.CopyRspackPlugin({
        patterns: [
          {
            from: path.resolve(__dirname, "src/favicon.png"),
            to: "favicon.png",
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
  },
];
