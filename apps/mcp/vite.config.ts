import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: () => 'index.mjs',
    },
    outDir: 'dist',
    target: 'node24',
    minify: false,
    sourcemap: true,
    rollupOptions: {
      external: [/^node:/],
    },
  },
});
