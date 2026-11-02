/**
 * SUB1 验收（条件 1 的真实 HTTP 段）：合成 magpie 的 `GET /v1/models` 回 3 个
 * `prov/model`，IXAEON 现有的检测通道（`listUpstreamModels`）能原样列出来。
 *
 * 规格 docs/委派/SUB1-直接接magpie.md 条件 1：点「用本机 magpie」后 API 地址、Key 填好，
 * 模型清单里正好这 3 个。界面接线在 apps/desktop/test/acceptance/sub1-magpie-preset.test.ts
 * （那里把检测结果换成替身，只钉「按钮走预设的地址与 Key」）；这里起真的本机 HTTP 服务，
 * 钉住 magpie 的 OpenAI 兼容形状（`{ data: [{ id: 'prov/model' }] }`）与 Bearer magpie。
 */
import { createServer, type Server } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { listUpstreamModels } from '../../src/extraction/model/openai.js';

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

interface SyntheticMagpie {
  url: string;
  authorization: string[];
}

async function startMagpie(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<SyntheticMagpie> {
  const authorization: string[] = [];
  const server = createServer((req, res) => {
    authorization.push(String(req.headers.authorization ?? ''));
    handler(req, res);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('合成 magpie 没拿到端口');
  return { url: `http://127.0.0.1:${address.port}/v1`, authorization };
}

describe('SUB1 条件 1：合成 magpie 的 /v1/models', () => {
  it('OpenAI 兼容形状回 3 个 prov/model → 检测到正好这 3 个，Key 走 Bearer magpie', async () => {
    const magpie = await startMagpie((_req, res) => {
      const body = JSON.stringify({
        object: 'list',
        data: [{ id: 'prov/m2' }, { id: 'prov/m1' }, { id: 'prov/m3' }],
      });
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
    });

    const models = await listUpstreamModels({
      apiBaseUrl: magpie.url,
      apiKey: 'magpie',
    });

    // 检测通道按名字排序（现有行为）；清单里正好这 3 个 `provider/model`。
    expect(models.map((m) => m.id)).toEqual(['prov/m1', 'prov/m2', 'prov/m3']);
    expect(magpie.authorization).toEqual(['Bearer magpie']);
  });

  it('magpie 没起（端口没人听）→ 检测报错，不会返回一份空清单冒充连上了', async () => {
    // 先起一个服务拿一个空闲端口，再关掉：这个端口上确定没人听。
    const temp = await startMagpie((_req, res) => res.end('{}'));
    const url = temp.url;
    const server = servers.pop()!;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));

    await expect(listUpstreamModels({ apiBaseUrl: url, apiKey: 'magpie' })).rejects.toThrow();
  });
});
