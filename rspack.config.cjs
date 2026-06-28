// rspack.config.cjs — Rspack 构建配置（生产/开发双模式）

const rspack = require("@rspack/core");
const path = require("path");

const isDev = process.env.NODE_ENV === "development";

/** @type {import('@rspack/core').Configuration} */
module.exports = {
  mode: isDev ? "development" : "production",
  context: __dirname,
  entry: "./src/main.js",
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: isDev ? "main.js" : "main.[contenthash:8].js",
    clean: true,
  },
  devServer: {
    port: 3000,
    hot: true,
    open: false,
    static: {
      directory: path.resolve(__dirname, "dist"),
    },
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
        { from: path.resolve(__dirname, "src/mitm.html"), to: "mitm.html" },
        { from: path.resolve(__dirname, "src/sw.js"), to: "sw.js" },
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
};
