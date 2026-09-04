import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * MCP 配置片段生成（Codex CLI / 桌面端 / IDE 共用本机配置）。
 *
 * 运行时方案（修复 P1-3）：不依赖全局 Node.js。
 * - command = Electron 可执行文件本身（IXAEON.exe）
 * - env: ELECTRON_RUN_AS_NODE=1 → Electron 以纯 Node 运行时模式执行脚本
 * - args = [MCP 入口, ...]（Electron run-as-node 模式下第一个参数即脚本路径）
 * - 入口文件：
 *   - 安装版：<exe 目录>\resources\mcp\index.mjs（electron-builder extraResources 固定复制）
 *   - 开发版：仓库 apps/mcp/dist/index.mjs（从 exe 位置向上定位仓库根，校验存在）
 * 片段带 IXAEON_LOCAL_TOKEN 环境变量（localToken），复制即用。
 */
export function getMcpSnippet(
  execPath: string,
  localToken: string | null,
): {
  serverName: string;
  command: string;
  args: string[];
  snippet: string;
  localToken: string | null;
} {
  const { command, args, mcpEntry } = resolveMcpCommand(execPath);
  // ELECTRON_RUN_AS_NODE：Electron 以纯 Node 运行时执行入口脚本（无需全局 Node.js）
  const envLines = localToken !== null ? `, "IXAEON_LOCAL_TOKEN": "${localToken}"` : '';
  const tokenLine = `,\n      "env": { "ELECTRON_RUN_AS_NODE": "1"${envLines} }`;
  const snippet = [
    '{',
    `  "mcpServers": {`,
    `    "ixaeon": {`,
    `      "command": "${command.replace(/\\/g, '\\\\')}",`,
    `      "args": ["${mcpEntry.replace(/\\/g, '\\\\')}"]${tokenLine}`,
    `    }`,
    `  }`,
    '}',
  ].join('\n');
  return { serverName: 'ixaeon', command, args, snippet, localToken };
}

/**
 * 解析 MCP 启动命令与入口。
 * 开发模式：从 Electron 可执行位置向上找仓库根（apps/mcp/dist/index.mjs 必须真实存在）；
 * 安装模式：resources/mcp/index.mjs。
 * 返回的 command 始终是 Electron 可执行文件（ELECTRON_RUN_AS_NODE 模式），
 * 全新 Windows 用户无需安装 Node.js。
 */
export function resolveMcpCommand(execPath: string): {
  command: string;
  args: string[];
  mcpEntry: string;
  mode: 'dev' | 'packaged';
} {
  const isDevElectron = execPath.includes('node_modules') || execPath.includes('apps');
  if (isDevElectron) {
    // 开发模式：out/main → 仓库根/apps/mcp/dist/index.mjs（校验存在，不存在继续向上找）
    let dir = dirname(execPath);
    for (let i = 0; i < 8; i++) {
      const candidate = resolve(dir, 'apps', 'mcp', 'dist', 'index.mjs');
      if (existsSync(candidate)) {
        return { command: execPath, args: [candidate], mcpEntry: candidate, mode: 'dev' };
      }
      const parent = resolve(dir, '..');
      if (parent === dir) break;
      dir = parent;
    }
    // 开发模式找不到 dist：指向最近候选（构建后存在）；调用方测试会断言存在
    const fallback = resolve(
      dirname(execPath),
      '..',
      '..',
      '..',
      'apps',
      'mcp',
      'dist',
      'index.mjs',
    );
    return { command: execPath, args: [fallback], mcpEntry: fallback, mode: 'dev' };
  }
  // 安装模式：exe 同级 resources/mcp/index.mjs（electron-builder extraResources）
  const mcpEntry = resolve(execPath, '..', 'resources', 'mcp', 'index.mjs');
  return { command: execPath, args: [mcpEntry], mcpEntry, mode: 'packaged' };
}
