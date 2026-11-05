/**
 * MP3 验收条件 2：`resolveModelUseChain(config, use)` 按顺序取一串候选。
 *
 * 逐条对应规格「验收条件」第 2 条：
 * - 顺序是主选在前，替补依次在后；
 * - 主选那家没了 / 没 Key 时，从第一个能解析的替补开始；
 * - 按「哪家 + 哪个模型」去重，保留先出现的；
 * - 聊天没单独选过（uses.chat 没有、chatModelName 也空）：整串等于后台分析那一串，
 *   聊天自己的替补不生效；
 * - 一个都解析不出来：返回空数组。
 *
 * 现在 `resolveModelUseChain` 还没实现，本文件会红在「不是函数」——B 档先推测试的预期。
 * 用「运行时取」的写法，别让整份文件起不来。
 */
import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import * as core from '@ixaeon/core';
import { defaultAppConfig, type AppConfig } from '@ixaeon/contracts';

const KEY_A = Buffer.from('enc:sk-synthetic-a1b2c3d4').toString('base64');
const KEY_B = Buffer.from('enc:sk-synthetic-b9f8e7d6').toString('base64');
const KEY_C = Buffer.from('enc:sk-synthetic-c5d6e7f8').toString('base64');

type Choice = { providerId: string; model: string };

/** 运行时取还没导出的函数：没有时是 undefined，调用时才报错（不让 import 挂掉整份文件）。 */
function chainFn(): (
  config: AppConfig,
  use: 'analysis' | 'chat',
) => Array<{
  providerId: string;
  model: string;
}> {
  const fn = (core as unknown as Record<string, unknown>)['resolveModelUseChain'];
  expect(typeof fn).toBe('function');
  return fn as never;
}

function provider(id: string, name: string, base: string, enc: string | null, models: string[]) {
  return {
    id,
    name,
    kind: 'openai' as const,
    apiBaseUrl: base,
    apiKeyEncrypted: enc,
    apiKeyPresent: enc !== null,
    savedModels: models,
    modelsCheckedAt: null,
  };
}

function config(over: {
  uses?: Record<string, Choice>;
  fallbacks?: { analysis?: Choice[]; chat?: Choice[] };
  chatModelName?: string;
}): AppConfig {
  const base = defaultAppConfig();
  return {
    ...base,
    model: {
      ...base.model,
      modelName: 'demo-a',
      chatModelName: over.chatModelName ?? '',
      apiBaseUrl: 'http://127.0.0.1:18081/v1',
      apiKeyEncrypted: KEY_A,
      apiKeyPresent: true,
      savedModels: ['demo-a'],
    },
    providers: [
      provider('p-a', '合成甲', 'http://127.0.0.1:18081/v1', KEY_A, ['demo-a']),
      provider('p-b', '合成乙', 'http://127.0.0.1:18082/v1', KEY_B, ['demo-b']),
      provider('p-c', '合成丙', 'http://127.0.0.1:18083/v1', KEY_C, ['demo-c']),
    ],
    uses: (over.uses ?? {}) as AppConfig['uses'],
    ...({ fallbacks: over.fallbacks ?? {} } as Record<string, unknown>),
  } as AppConfig;
}

describe('MP3 条件 2：resolveModelUseChain', () => {
  it('顺序是主选在前，替补依次在后', () => {
    const cfg = config({
      uses: { analysis: { providerId: 'p-a', model: 'demo-a' } },
      fallbacks: {
        analysis: [
          { providerId: 'p-b', model: 'demo-b' },
          { providerId: 'p-c', model: 'demo-c' },
        ],
      },
    });
    expect(chainFn()(cfg, 'analysis').map((c) => `${c.providerId}/${c.model}`)).toEqual([
      'p-a/demo-a',
      'p-b/demo-b',
      'p-c/demo-c',
    ]);
  });

  it('主选那家没了时，从第一个能解析的替补开始', () => {
    const cfg = config({
      uses: { analysis: { providerId: 'p-x', model: 'demo-x' } },
      fallbacks: {
        analysis: [
          { providerId: 'p-b', model: 'demo-b' },
          { providerId: 'p-c', model: 'demo-c' },
        ],
      },
    });
    expect(chainFn()(cfg, 'analysis').map((c) => c.providerId)).toEqual(['p-b', 'p-c']);
  });

  it('主选那家没 Key 时也跳过，从第一个能解析的替补开始', () => {
    const cfg = config({
      uses: { analysis: { providerId: 'p-a', model: 'demo-a' } },
      fallbacks: {
        analysis: [
          { providerId: 'p-b', model: 'demo-b' },
          { providerId: 'p-c', model: 'demo-c' },
        ],
      },
    });
    const a = (cfg.providers as Array<Record<string, unknown>>).find((p) => p['id'] === 'p-a')!;
    a['apiKeyEncrypted'] = null;
    a['apiKeyPresent'] = false;
    expect(chainFn()(cfg, 'analysis')[0]!.providerId).toBe('p-b');
  });

  it('去重：同一家同一个模型只留先出现的', () => {
    const cfg = config({
      uses: { analysis: { providerId: 'p-a', model: 'demo-a' } },
      fallbacks: {
        analysis: [
          { providerId: 'p-b', model: 'demo-b' },
          { providerId: 'p-a', model: 'demo-a' },
          { providerId: 'p-b', model: 'demo-b' },
        ],
      },
    });
    expect(chainFn()(cfg, 'analysis').map((c) => `${c.providerId}/${c.model}`)).toEqual([
      'p-a/demo-a',
      'p-b/demo-b',
    ]);
  });

  it('聊天没单独选过：整串等于后台分析那串，聊天自己的替补不生效', () => {
    const cfg = config({
      uses: { analysis: { providerId: 'p-a', model: 'demo-a' } },
      fallbacks: {
        analysis: [{ providerId: 'p-b', model: 'demo-b' }],
        chat: [{ providerId: 'p-c', model: 'demo-c' }],
      },
    });
    const chat = chainFn()(cfg, 'chat');
    const analysis = chainFn()(cfg, 'analysis');
    expect(chat.map((c) => `${c.providerId}/${c.model}`)).toEqual(
      analysis.map((c) => `${c.providerId}/${c.model}`),
    );
    expect(chat.map((c) => c.providerId)).not.toContain('p-c');
  });

  it('一个都解析不出来：返回空数组', () => {
    const cfg = config({
      uses: { analysis: { providerId: 'p-x', model: 'demo-x' } },
      fallbacks: { analysis: [{ providerId: 'p-y', model: 'demo-y' }] },
    });
    expect(chainFn()(cfg, 'analysis')).toEqual([]);
  });
});
