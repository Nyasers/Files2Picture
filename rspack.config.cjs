// rspack.config.cjs — Rspack 构建配置（多文件输出，CSS/HTML 全量压缩）

const rspack = require("@rspack/core");
const path = require("path");

/** @type {import('@rspack/core').Configuration} */
module.exports = {
  context: __dirname,
  entry: "./src/main.js",
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "main.[contenthash:8].js",
    clean: true,
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
      minify: true,
    }),
    new rspack.CssExtractRspackPlugin({
      filename: "style.[contenthash:8].css",
    }),
  ],
  optimization: {
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
        minimizerOptions: {
          errorRecovery: false,
        },
      }),
    ],
  },
};
