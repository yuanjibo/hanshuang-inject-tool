import path from "node:path";
import { defineConfig } from "vite";

/**
 * 打包版本地服务：把 server/standalone.ts 和它引用的插件打成单文件 server.mjs。
 * 前端仍由 `pnpm build`（vite.config.ts）输出到 dist/。
 */
export default defineConfig({
  build: {
    ssr: path.resolve(__dirname, "server/standalone.ts"),
    outDir: path.resolve(__dirname, "release/寒霜注入工具-1.0.0"),
    emptyOutDir: false,
    target: "node20",
    minify: false,
    sourcemap: false,
    rollupOptions: {
      output: {
        entryFileNames: "server.mjs",
        format: "esm",
      },
    },
  },
  ssr: {
    // 把 smol-toml 等运行时依赖一起打进 server.mjs，发布包不需要 node_modules
    noExternal: true,
    target: "node",
  },
});
