import { expect } from '@playwright/test';

/**
 * 界面测试共用前置检查（C3 验收条件 5）：
 * 默认端口被占时给出「先关掉正在运行的 IXAEON」的明确提示，而不是含糊失败。
 * 检查只读，绝不触碰正在运行的服务。
 */
export async function assertDefaultPortFree(port = 43191): Promise<void> {
  const occupied = await fetch(`http://127.0.0.1:${port}/api/health`, {
    signal: AbortSignal.timeout(1000),
  }).then(
    () => true,
    () => false,
  );
  expect(
    occupied,
    `IXAEON 默认端口 ${port} 已被占用：有正在运行的 IXAEON，请先关闭它再跑界面测试（本测试不会动正在运行的服务）`,
  ).toBe(false);
}
