import { expect } from '@playwright/test';

/**
 * 界面测试共用前置检查（C3 验收条件 5）。
 *
 * 判定规则（Codex 第二轮意见）：只有「连接被拒」（ECONNREFUSED）才说明
 * 端口空闲；有服务在响应、响应超时、连接被断开等都按「被占」处理，
 * 给出「先关掉正在运行的 IXAEON」的明确提示，而不是含糊失败。
 * 检查只读，绝不触碰正在运行的服务。
 */
export async function assertDefaultPortFree(port = 43191): Promise<void> {
  let occupied: boolean;
  try {
    await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1000),
    });
    // 端口上有东西在响应（哪怕是错误响应）——不是空闲
    occupied = true;
  } catch (e) {
    const code = (e as { cause?: { code?: string } }).cause?.code ?? (e as Error).name;
    occupied = code !== 'ECONNREFUSED';
  }
  expect(
    occupied,
    `IXAEON 默认端口 ${port} 已被占用：有正在运行的 IXAEON，请先关闭它再跑界面测试（本测试不会动正在运行的服务）`,
  ).toBe(false);
}
