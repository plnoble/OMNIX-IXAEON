// Independent shipped-artifact review. No installation, real profile, API key, or model call.
// Run from repository root: node apps/desktop/test/review/packaged-20260905.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { _electron as electron } from 'playwright';

const occupied = await fetch('http://127.0.0.1:43191/api/health', {
  signal: AbortSignal.timeout(1500),
}).then(
  () => true,
  () => false,
);
assert.equal(occupied, false, 'Existing desktop service detected; do not touch it.');
const root = mkdtempSync(join(tmpdir(), 'ixaeon-packaged-review-'));
const install = process.env.IXAEON_REVIEW_INSTALL_DIR ?? join(root, 'IXAEON');
if (!process.env.IXAEON_REVIEW_INSTALL_DIR) {
  // Use native PowerShell copying: Node cpSync exited unexpectedly on this review host.
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Copy-Item -LiteralPath $env:IXAEON_REVIEW_COPY_SOURCE -Destination $env:IXAEON_REVIEW_COPY_DEST -Recurse -ErrorAction Stop',
    ],
    {
      windowsHide: true,
      env: {
        ...process.env,
        IXAEON_REVIEW_COPY_SOURCE: resolve('apps/desktop/release/win-unpacked'),
        IXAEON_REVIEW_COPY_DEST: install,
      },
    },
  );
}
const executable = join(install, 'IXAEON.exe');
const customData = join(root, 'chosen-data');
const seed = join(root, 'seed.md');
writeFileSync(seed, '# Packaged acceptance\n\nREVIEWPACKAGEDMARKER original source.\n');
for (const dir of ['Roaming', 'Local', 'profile']) mkdirSync(join(root, dir));
const env = {
  ...process.env,
  APPDATA: join(root, 'Roaming'),
  LOCALAPPDATA: join(root, 'Local'),
  IXAEON_TEST_DIALOG_RESPONSES: `documents|${seed}`,
};
delete env.IXAEON_DATA_DIR;
delete env.IXAEON_LOCAL_TOKEN;
delete env.IXAEON_FAKE_MODEL;
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
const checks = [];
let app;
let mcp;
let lineReader;
const pending = new Map();

async function launch() {
  app = await electron.launch({
    executablePath: executable,
    args: [`--user-data-dir=${join(root, 'profile')}`],
    env,
    timeout: 30_000,
  });
  const page = await app.firstWindow();
  await page.getByTestId('app-root').waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.hide()));
  return page;
}

let nextId = 0;
function request(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolveResponse, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP timeout: ${method}`));
    }, 15_000);
    pending.set(id, { resolve: resolveResponse, reject, timer });
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

async function call(name, args) {
  const response = await request('tools/call', { name, arguments: args });
  assert.equal(response.result?.isError, undefined, `${name} returned a tool error`);
  const content = response.result?.content?.find((x) => x.type === 'text');
  assert.ok(content, `${name} returned no content`);
  return JSON.parse(content.text);
}

try {
  let page = await launch();
  await page.getByTestId('setup-wizard').waitFor();
  // 2026-09-08 重构：自定义目录改为原生「选择目录」按钮（不再有勾选框）。
  // 按钮存在且未禁用 = 未被 IXAEON_DATA_DIR 覆盖时可选自定义目录。
  const disabled = await page.getByTestId('setup-pick-dir').isDisabled();
  checks.push({
    check: 'custom directory picker button without IXAEON_DATA_DIR override',
    ok: !disabled,
    disabled,
  });

  // The picker may be broken. Independently test backend save + genuine process restart via public IPC.
  const setup = await page.evaluate(
    async (dataDir) =>
      window.ixaeon.completeSetup({
        dataDir,
        modelName: 'review-no-network',
        apiBaseUrl: '',
        apiKey: '',
        projectName: 'PackagedReview',
        projectRootPath: null,
      }),
    customData,
  );
  assert.equal(setup.restartRequired, true);
  await app.close();
  app = undefined;
  page = await launch();
  await page.getByTestId('main-nav').waitFor();
  const state = await page.evaluate(() => window.ixaeon.getState());
  assert.equal(state.setupComplete, true);
  assert.equal(state.dataDir, customData);
  const projects = await page.evaluate(() => window.ixaeon.listProjects());
  const project = projects.find((p) => p.name === 'PackagedReview');
  assert.ok(project);
  checks.push({
    check: 'backend custom directory save, full process restart and project persistence',
    ok: true,
  });

  const imported = await page.evaluate(async (projectId) => {
    const selection = await window.ixaeon.pickFiles('documents');
    return window.ixaeon.importPaths({ ticket: selection.ticket, projectId });
  }, project.id);
  assert.ok(imported);

  const settings = await page.evaluate(() => window.ixaeon.getSettings());
  const spec = JSON.parse(settings.mcp.snippet).mcpServers.ixaeon;
  assert.equal(spec.command, executable);
  assert.equal(spec.args[0], join(install, 'resources', 'mcp', 'index.mjs'));
  const mcpEnv = {
    ...env,
    ...spec.env,
    PATH: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'),
  };
  mcp = spawn(spec.command, spec.args, {
    env: mcpEnv,
    cwd: root,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  mcp.stderr.resume(); // Never print credentials or arbitrary process output.
  lineReader = createInterface({ input: mcp.stdout });
  lineReader.on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(`MCP protocol error ${message.error.code}`));
    else waiter.resolve(message);
  });
  const initialized = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'independent-review', version: '1' },
  });
  assert.ok(initialized.result.serverInfo);
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const listed = await request('tools/list');
  assert.equal(listed.result.tools.length, 4);
  const prepared = await call('prepare_task', {
    project_ref: project.id,
    task: 'Independent packaged acceptance',
    max_chars: 4000,
  });
  assert.equal(prepared.project_id, project.id);
  const searched = await call('search_context', {
    project_ref: project.id,
    query: 'REVIEWPACKAGEDMARKER',
    limit: 8,
  });
  assert.ok(searched.results.length > 0);
  const excerpt = await call('get_source_excerpt', {
    ref: searched.results[0].ref,
    max_chars: 1000,
  });
  assert.ok(excerpt.excerpt.includes('REVIEWPACKAGEDMARKER'));
  const written = await call('record_work_result', {
    project_ref: project.id,
    agent_name: 'independent-review',
    task: 'Packaged MCP read and write',
    outcome: 'success',
    summary: 'Isolated test data only',
    changes: [],
    tests: [{ name: 'All four MCP tools', result: 'passed' }],
    open_loops: [],
  });
  assert.ok(written.work_run_id);
  const rows = await page.evaluate(
    (projectId) => window.ixaeon.listWorkRuns({ projectId, limit: 10 }),
    project.id,
  );
  assert.ok(rows.some((row) => row.id === written.work_run_id));
  checks.push({
    check:
      'relocated win-unpacked binary, copied config, no global Node PATH, STDIO handshake and all four tools, persisted write',
    ok: true,
  });
} finally {
  for (const waiter of pending.values()) clearTimeout(waiter.timer);
  lineReader?.close();
  if (mcp) {
    const exited = new Promise((done) => mcp.once('exit', done));
    mcp.kill();
    if (mcp.exitCode === null) await exited;
  }
  if (app) await app.close();
  console.log(JSON.stringify({ root, checks }, null, 2));
}
if (checks.some((check) => !check.ok)) process.exitCode = 1;
