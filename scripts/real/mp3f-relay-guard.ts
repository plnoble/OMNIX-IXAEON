/**
 * MP3f 真机检查：合成 relay 目录里试一次「审查撞开发」，打印拒绝提示与前后 diff。
 *
 *   node scripts/real/mp3f-relay-guard.mjs
 *
 * 不碰用户真实的 relay 目录；不跑真实的开发工具；不打印路径（临时目录遮成 <临时目录>）。
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRelayModels, setRelayModel } from '../../packages/core/src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'ixaeon-mp3f-real-'));
const mask = (s) => String(s).replaceAll(dir, '<临时目录>');

const PATCH = `- id: sandbox-policy
  config:
    mode: danger-full-access

- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      gw-a:
        apiKeyEnv: SECRET-XYZ
        api: openai-completions
        baseURL: https://gw.example.invalid
        models:
          - id: gpt-x
            name: gpt-x

- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: gw-a
    model: gpt-x
`;
const patchPath = join(dir, 'relay.patch.yml');
const configPath = join(dir, 'config.json');
writeFileSync(patchPath, PATCH, 'utf8');
writeFileSync(
  configPath,
  `${JSON.stringify(
    {
      roles: {
        developer: {
          argv: ['node', 'dsh.mjs', '--patch', patchPath, '--json', '{prompt_file}'],
          cwd: 'C:\\work',
        },
      },
      idleSeconds: 60,
    },
    null,
    2,
  )}\n`,
  'utf8',
);
process.env['DSH_HOME'] = join(dir, 'dsh-home');

const before = { config: readFileSync(configPath, 'utf8'), patch: readFileSync(patchPath, 'utf8') };
setRelayModel({ relayDir: dir }, { role: 'developer', value: 'gw-a / gpt-x' });
const mid = { config: readFileSync(configPath, 'utf8'), patch: readFileSync(patchPath, 'utf8') };
let msg = '';
try {
  setRelayModel({ relayDir: dir }, { role: 'reviewer', value: 'gpt-x' });
} catch (err) {
  msg = err instanceof Error ? err.message : String(err);
}
const after = { config: readFileSync(configPath, 'utf8'), patch: readFileSync(patchPath, 'utf8') };
const dev = readRelayModels({ relayDir: dir }).roles.find((r) => r.role === 'developer');

console.log('拒绝提示：', mask(msg));
console.log('被拒后 config 有变化：', after.config !== mid.config);
console.log('被拒后补丁有变化：', after.patch !== mid.patch);
console.log(
  '留下的 .bak 个数：',
  readdirSync(dir).filter((f) => f.startsWith('relay.patch.yml.bak-')).length,
);
console.log('开发行（读回）：', mask(String(dev?.current ?? '')));
console.log('初始 config / 现状 config 字节数：', before.config.length, '/', after.config.length);

rmSync(dir, { recursive: true, force: true });
