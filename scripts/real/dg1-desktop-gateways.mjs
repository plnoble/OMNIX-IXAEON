#!/usr/bin/env node
/**
 * DG1 真机检查：接力的 DSH 真的能用桌面版里新加的网关模型答话。
 *
 * 做法（照规格）：用用户真实的桌面版配置（**只读**），只取顶层 `- id: llm-pi-ai` 那一项；
 * 从里面挑一个「桌面版登记了、接力补丁里没有」的网关模型，临时写一个 `agent-default-model`
 * 补丁把默认模型指过去，起一次 DSH headless，只问「只回复两个字母：OK」。
 *
 * 输出只有退出码和含 OK 的那一行（找不到就说明没找到）；**不打印配置内容**，
 * 也不改桌面版配置和接力补丁。临时文件用完就删。
 *
 * 用法：node scripts/real/dg1-desktop-gateways.mjs
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  desktopGatewayConfigPath,
  extractDesktopGateway,
} from '../../packages/relay/src/gateway.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LAUNCHER = join(REPO, 'packages', 'relay', 'bin', 'dsh.mjs');

/** 公开仓库：输出里不出现本机账户名，把用户目录换成 `~`。 */
function maskHome(text) {
  const home = homedir();
  if (!home) return text;
  const forms = [home, home.replaceAll('\\', '/'), JSON.stringify(home).slice(1, -1)];
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return forms.reduce((s, p) => s.replace(new RegExp(escape(p), 'gi'), '~'), text);
}

/** 网关 / 模型对：`providers:` 下一层缩进的 `<网关名>:`，它下面 `models:` 里的 `- id:`。 */
function gatewayModels(item) {
  const pairs = [];
  let gateway = null;
  for (const line of item.split(/\r?\n/)) {
    const gw = /^ {6}([A-Za-z0-9._-]+):\s*$/.exec(line);
    if (gw) {
      gateway = gw[1];
      continue;
    }
    const model = /^ {10}- id:\s*(\S+)\s*$/.exec(line);
    if (model && gateway) pairs.push({ gateway, model: model[1] });
  }
  return pairs;
}

function main() {
  const tempFiles = [];
  const tempFile = (suffix, text) => {
    const file = join(tmpdir(), `ixa-dg1-real-${randomBytes(8).toString('hex')}${suffix}`);
    writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
    tempFiles.push(file);
    return file;
  };

  try {
    const desktopPath = desktopGatewayConfigPath();
    if (!existsSync(desktopPath)) {
      console.log('没找到 DSH 桌面版的配置，这一项没法跑');
      return 1;
    }
    const item = extractDesktopGateway(readFileSync(desktopPath, 'utf8'));
    if (!item) {
      console.log('DSH 桌面版配置里没有 llm-pi-ai 网关段，这一项没法跑');
      return 1;
    }
    const relayPath = join(homedir(), '.dsh', 'ixaeon-relay.patch.yml');
    const relayText = existsSync(relayPath) ? readFileSync(relayPath, 'utf8') : '';
    const fresh = gatewayModels(item).filter(({ model }) => !relayText.includes(model));
    const pick = fresh.find((p) => p.gateway === 'magpie') ?? fresh[0];
    if (!pick) {
      console.log('桌面版里没有接力补丁里不存在的网关模型，这一项没法证明「新网关也能用」');
      return 1;
    }

    const gatewayFile = tempFile('.yml', item);
    const modelFile = tempFile(
      '.yml',
      [
        '- id: agent-default-model',
        '  config:',
        `    provider: ${pick.gateway}`,
        `    model: ${pick.model}`,
        '',
      ].join('\n'),
    );

    const r = spawnSync(
      process.execPath,
      [
        LAUNCHER,
        '--profile',
        'headless',
        '--patch',
        gatewayFile,
        '--patch',
        modelFile,
        '--json',
        '只回复两个字母：OK',
      ],
      {
        cwd: REPO,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 300_000,
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    const okLine = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && /\bOK\b/.test(l))
      .at(-1);
    const result =
      okLine && r.status === 0
        ? `含 OK 的那一行：${maskHome(okLine)}`
        : okLine
          ? `有 OK 但退出码不是 0，含 OK 的那一行：${maskHome(okLine)}`
          : '没有含 OK 的那一行';
    console.log(`退出码：${r.status ?? `null（${r.error?.message ?? '超时或起不来'}）`}`);
    console.log(result);
    return r.status === 0 && okLine ? 0 : 1;
  } finally {
    for (const file of tempFiles) {
      try {
        rmSync(file, { force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        /* 临时文件删不掉不算检查失败 */
      }
    }
  }
}

process.exitCode = main();
