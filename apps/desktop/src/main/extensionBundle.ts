import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { app } from 'electron';

export interface BundledExtensionInfo {
  loadUnpackedDir: string;
  available: boolean;
}

/**
 * 把随包扩展拷到用户数据目录，Chrome「加载已解压」指向这里。
 * 开发模式用仓库 apps/extension/dist。
 */
export function syncBundledExtension(): BundledExtensionInfo {
  const dest = join(app.getPath('userData'), 'extension');
  mkdirSync(dest, { recursive: true });
  const src = resolveExtensionSource();
  if (src && existsSync(join(src, 'manifest.json'))) {
    cpSync(src, dest, { recursive: true });
  }
  writeFileSync(
    join(dest, 'README-加载说明.txt'),
    [
      'Chrome / Edge：chrome://extensions → 打开开发者模式 → 加载已解压的扩展程序',
      `选这个目录：${dest}`,
      '然后打开 IXAEON 设置 → 显示配对码，在扩展弹窗里输入。',
      '只采集当前打开的 chatgpt.com 对话。',
      '',
    ].join('\n'),
    'utf8',
  );
  return { loadUnpackedDir: dest, available: existsSync(join(dest, 'manifest.json')) };
}

function resolveExtensionSource(): string | null {
  const packaged = join(process.resourcesPath, 'extension');
  if (existsSync(join(packaged, 'manifest.json'))) return packaged;
  let dir = dirname(app.getAppPath());
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, 'apps', 'extension', 'dist');
    if (existsSync(join(candidate, 'manifest.json'))) return candidate;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
