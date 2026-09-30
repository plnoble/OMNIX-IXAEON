/**
 * e2e 全局前置（V2 步骤 2）：默认端口被占时给出「先关掉正在运行的
 * IXAEON」的明确提示，不再跑出一堆含糊失败。只读检查，不触碰在跑的服务。
 * 判定同 apps/desktop/test/review/ui-port-guard.ts：只有 ECONNREFUSED
 * 才算端口空闲。
 */
export default async function globalSetup(): Promise<void> {
  const port = Number(process.env.IXAEON_DESKTOP_PORT ?? 43191);
  let occupied: boolean;
  try {
    await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1000),
      redirect: 'manual',
    });
    occupied = true;
  } catch (e) {
    const code = (e as { cause?: { code?: string } }).cause?.code ?? (e as Error).name;
    occupied = code !== 'ECONNREFUSED';
  }
  if (occupied) {
    throw new Error(
      `IXAEON 默认端口 ${port} 已被占用：有正在运行的 IXAEON，请先关闭它再跑端到端测试（本测试不会动正在运行的服务）`,
    );
  }
}
