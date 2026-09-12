import { defineConfig } from 'vite';

// 双入口：
// - index：安装包用（HTTP 转发）。不得依赖 @ixaeon/core——它引入
//   better-sqlite3（原生模块）；安装包 resources/mcp 没有 node_modules，
//   顶层静态引用会让打包后的服务直接崩。better-sqlite3 external。
// - direct：仓库/验证场景用（IXAEON_MCP_DB_PATH 进程内直连），
//   打包时被 extraResources 排除。
export default defineConfig({
  build: {
    lib: {
      entry: { index: 'src/index.ts', direct: 'src/direct.ts' },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.mjs`,
    },
    outDir: 'dist',
    target: 'node24',
    minify: false,
    sourcemap: true,
    rollupOptions: {
      external: [/^node:/, 'better-sqlite3'],
    },
  },
});
