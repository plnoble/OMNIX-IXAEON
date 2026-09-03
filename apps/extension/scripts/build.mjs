#!/usr/bin/env node
/**
 * 扩展构建：
 * 1. content.ts → dist/content.js（IIFE：MV3 content script 不支持模块）
 * 2. background.ts / popup.ts → dist/*.js（ESM：模块 Service Worker 与弹窗页面）
 * 3. 复制 manifest.json 与 popup.html
 */
import { build } from 'vite';
import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'dist');
mkdirSync(dist, { recursive: true });

const shared = {
  configFile: false,
  logLevel: 'info',
  build: {
    target: 'chrome116',
    minify: false,
    emptyOutDir: false,
  },
};

await build({
  ...shared,
  build: {
    ...shared.build,
    lib: {
      entry: resolve(root, 'src/content.ts'),
      formats: ['iife'],
      name: 'IxaContent',
      fileName: () => 'content.js',
    },
    outDir: dist,
  },
});

await build({
  ...shared,
  build: {
    ...shared.build,
    lib: {
      entry: resolve(root, 'src/background.ts'),
      formats: ['es'],
      fileName: () => 'background.js',
    },
    outDir: dist,
  },
});

await build({
  ...shared,
  build: {
    ...shared.build,
    lib: {
      entry: resolve(root, 'src/popup/popup.ts'),
      formats: ['es'],
      fileName: () => 'popup.js',
    },
    outDir: dist,
  },
});

copyFileSync(resolve(root, 'manifest.json'), resolve(dist, 'manifest.json'));
copyFileSync(resolve(root, 'src/popup/popup.html'), resolve(dist, 'popup.html'));
console.log('[ixaeon-extension] 构建完成 →', dist);
