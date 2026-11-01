/**
 * K10a：调度器与模型（规格 docs/委派/K10a-调度器面板.md）。
 * 只读出 provider / model 名字、整合方 argv 里的 `--model` 值、`review.codexModel`；
 * 密钥、网关地址、整段 argv 不出这个模块，也不进报错。改文件前留 `.bak-<YYYYMMDD-HHmmss>`，
 * 写入走「临时文件 → 改名」。DSH 补丁只改 agent-default-model 那段的 provider / model 两行。
 */
import { randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type * as C from '@ixaeon/contracts';
import { ErrorCodes, IxaError } from '@ixaeon/contracts';

type Json = Record<string, unknown>;
type Model = { provider: string; model: string };
type Patch = { current: Model | null; options: string[]; ok: boolean; note: string | null };
type Range = { start: number; end: number };

const ROLES: C.RelayModelRole[] = [
  'developer',
  'integrator',
  'reviewer',
  'reviewerSubstitute',
  'integratorSubstitute',
];
const INTEGRATOR_OPTIONS = ['默认', 'opus', 'sonnet', 'haiku'];
const DEFAULT_INTEGRATOR = '默认';
const DEFAULT_REVIEWER = '跟 Codex 自己的设置';
/** 桌面版网关段里 magpie 那一节的名字；开发选 magpie 的模型 / 分组时写这个 provider。 */
const MAGPIE_PROVIDER = 'magpie';
/** MG2：面板上现取的 magpie 模型 / 分组，以及连不上时给人看的那一句。 */
export type MagpieModels = { models: string[]; error: string | null };

function invalid(message: string): never {
  throw new IxaError(ErrorCodes.VALIDATION_FAILED, message);
}
const rec = (v: unknown): Json | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const dirOf = (d: string): string =>
  d.trim() || process.env.IXAEON_RELAY_DIR?.trim() || join(homedir(), '.ixaeon', 'relay');
function loadJson(path: string): Json | null {
  try {
    return rec(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

const noCr = (line: string): string => (line.endsWith('\r') ? line.slice(0, -1) : line);
const indentOf = (line: string): number => /^[ \t]*/.exec(line)?.[0].length ?? 0;
const unquote = (v: string): string => {
  const t = v.trim();
  const quoted =
    t.length > 1 &&
    ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")));
  return quoted ? t.slice(1, -1) : t;
};

/** 顶层 `- id: <id>` 那一项的 [start, end)。 */
function itemRange(lines: string[], id: string): Range | null {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = /^-\s+id:\s*(\S+)\s*(?:#.*)?$/.exec(noCr(lines[i]!));
    if (!m) continue;
    if (start >= 0) return { start, end: i };
    if (m[1] === id) start = i;
  }
  return start >= 0 ? { start, end: lines.length } : null;
}

/** agent-default-model 那段的 provider / model。 */
function defaultModel(lines: string[], range: Range): Model | null {
  let provider: string | null = null;
  let model: string | null = null;
  for (let i = range.start + 1; i < range.end && (!provider || !model); i++) {
    const t = noCr(lines[i]!).trim();
    const p = /^provider:\s*(.+?)\s*(?:#.*)?$/.exec(t);
    const m = /^model:\s*(.+?)\s*(?:#.*)?$/.exec(t);
    if (p) provider = unquote(p[1]!);
    if (m) model = unquote(m[1]!);
  }
  return provider && model ? { provider, model } : null;
}

/** llm-pi-ai 那段 providers: 下的「网关 / 模型」；baseURL、apiKeyEnv 等一律不读。 */
function gatewayOptions(lines: string[], range: Range): string[] {
  let at = -1;
  let pIndent = 0;
  for (let i = range.start + 1; i < range.end && at < 0; i++) {
    if (/^providers:\s*(?:#.*)?$/.test(noCr(lines[i]!).trim())) {
      at = i;
      pIndent = indentOf(lines[i]!);
    }
  }
  if (at < 0) return [];
  const out: string[] = [];
  let gIndent = -1;
  let gateway = '';
  let mIndent = -1;
  for (let i = at + 1; i < range.end; i++) {
    const raw = noCr(lines[i]!);
    const t = raw.trim();
    if (!t || t.startsWith('#')) continue;
    const ind = indentOf(raw);
    if (ind <= pIndent) break;
    const key = /^([^:\s#][^:]*):\s*(?:#.*)?$/.exec(t);
    if (gIndent < 0) {
      if (!key) continue;
      gIndent = ind;
      gateway = key[1]!;
      continue;
    }
    if (ind < gIndent) break;
    if (ind === gIndent) {
      if (key) {
        gateway = key[1]!;
        mIndent = -1;
      }
      continue;
    }
    if (t === 'models:') {
      mIndent = ind;
      continue;
    }
    const m = mIndent >= 0 && ind > mIndent ? /^-\s+id:\s*(.+?)\s*(?:#.*)?$/.exec(t) : null;
    const model = m ? unquote(m[1]!) : '';
    if (model) out.push(`${gateway} / ${model}`);
  }
  return out;
}

/**
 * 整合方复审补（2026-11-01，照规格「DSH 桌面版配置里登记的全部网关」）：DG1 起接力每棒从桌面版取
 * `llm-pi-ai` 网关段、排在最后整段盖住接力补丁里的旧副本，所以可选的「网关 / 模型」照桌面版列。
 * 桌面版配置不在、读不懂或没有网关段 → `null`（退回接力补丁里的）。只取名字，别的不读出来。
 */
function desktopGatewayOptions(): string[] | null {
  const dshHome = process.env.DSH_HOME?.trim();
  const path = join(dshHome || join(homedir(), '.dsh'), 'profiles', 'desktop', 'cordis.patch.yml');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const lines = raw.split('\n');
  const range = itemRange(lines, 'llm-pi-ai');
  return range ? gatewayOptions(lines, range) : null;
}

function readPatch(patchPath: string, magpie: MagpieModels | undefined): Patch {
  let raw: string;
  try {
    raw = readFileSync(patchPath, 'utf8');
  } catch {
    return { current: null, options: [], ok: false, note: '补丁文件读不懂' };
  }
  const lines = raw.split('\n');
  const defRange = itemRange(lines, 'agent-default-model');
  const current = defRange ? defaultModel(lines, defRange) : null;
  const gwRange = itemRange(lines, 'llm-pi-ai');
  const options = desktopGatewayOptions() ?? (gwRange ? gatewayOptions(lines, gwRange) : []);
  // MG2：magpie 的清单是现取的（桌面版那一节是手抄的，看不到后来建的分组）。
  for (const model of magpie?.models ?? []) options.push(`${MAGPIE_PROVIDER} / ${model}`);
  if (!current) {
    return {
      current: null,
      options,
      ok: false,
      note: options.length > 0 ? '补丁里读不出默认模型' : '补丁文件读不懂',
    };
  }
  const me = `${current.provider} / ${current.model}`;
  if (!options.includes(me)) options.push(me);
  return { current, options, ok: true, note: null };
}

/** argv 里 `--patch` 后面那一项；没有、出现多次、或后面不是值就当作读不懂。 */
function patchPath(argv: unknown): string | null {
  if (!Array.isArray(argv)) return null;
  const hits: number[] = [];
  argv.forEach((a, i) => {
    if (a === '--patch') hits.push(i);
  });
  if (hits.length !== 1) return null;
  const next = argv[hits[0]! + 1];
  return typeof next === 'string' && next.trim() && !next.startsWith('-') ? next.trim() : null;
}
const argvOf = (config: Json, key: string): unknown => rec(rec(config.roles)?.[key])?.argv;

function row(
  role: C.RelayModelRole,
  agent: C.RelayModelAgent,
  current: string | null,
  options: string[],
  configured: boolean,
  note: string | null,
): C.RelayModelRow {
  return { role, agent, current, options: [...new Set(options)], configured, note };
}

function dshRow(
  config: Json,
  role: C.RelayModelRole,
  key: string,
  missing: string,
  magpie: MagpieModels | undefined,
): C.RelayModelRow {
  const path = patchPath(argvOf(config, key));
  if (!path)
    return row(
      role,
      'dsh',
      null,
      [],
      false,
      key === 'developer' ? '命令行里没有 --patch' : missing,
    );
  const p = readPatch(path, magpie);
  return row(
    role,
    'dsh',
    p.current ? `${p.current.provider} / ${p.current.model}` : null,
    p.options,
    p.ok,
    p.note ?? (p.ok ? (magpie?.error ?? null) : null),
  );
}

export function readRelayModels(opts: {
  relayDir: string;
  magpieModels?: string[];
  magpieError?: string | null;
}): C.RelayModels {
  const magpie: MagpieModels = {
    models: opts.magpieModels ?? [],
    error: opts.magpieError ?? null,
  };
  const config = loadJson(join(dirOf(opts.relayDir), 'config.json'));
  if (!config) {
    return {
      roles: ROLES.map((role) =>
        row(
          role,
          role === 'integrator' ? 'claude' : role === 'reviewer' ? 'codex' : 'dsh',
          null,
          [],
          false,
          '读不到调度器配置',
        ),
      ),
    };
  }
  const integratorArgv = argvOf(config, 'integrator');
  const argv = Array.isArray(integratorArgv) ? (integratorArgv as unknown[]) : null;
  const at = argv ? argv.indexOf('--model') : -1;
  const model =
    argv && at >= 0 && typeof argv[at + 1] === 'string' ? (argv[at + 1] as string) : null;
  const integratorMagpie = str(rec(rec(config.roles)?.integrator)?.magpieModel);
  const codex = str(rec(config.review)?.codexModel);
  const reviewerMagpie = str(rec(config.review)?.magpieModel);
  const reviewerCurrent = reviewerMagpie ?? codex ?? DEFAULT_REVIEWER;
  const reviewerOptions = magpie.models.length ? ['默认', ...magpie.models] : codex ? [codex] : [];
  if (magpie.models.length && !reviewerOptions.includes(reviewerCurrent))
    reviewerOptions.push(reviewerCurrent);
  return {
    roles: [
      dshRow(config, 'developer', 'developer', '没配开发角色', magpie),
      row(
        'integrator',
        'claude',
        Array.isArray(integratorArgv) ? (integratorMagpie ?? model ?? DEFAULT_INTEGRATOR) : null,
        [...INTEGRATOR_OPTIONS, ...magpie.models],
        Array.isArray(integratorArgv),
        Array.isArray(integratorArgv) ? magpie.error : '调度器配置里没有整合方角色',
      ),
      row('reviewer', 'codex', reviewerCurrent, reviewerOptions, true, magpie.error),
      dshRow(config, 'reviewerSubstitute', 'reviewer', '没配', magpie),
      dshRow(config, 'integratorSubstitute', 'integratorSubstitute', '没配', magpie),
    ],
  };
}

function backup(path: string): void {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  try {
    copyFileSync(path, `${path}.bak-${stamp}`);
  } catch {
    invalid('备份文件写不进去');
  }
}

function writeAtomic(path: string, text: string): void {
  const tmp = join(
    dirname(path),
    `.${basename(path)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`,
  );
  try {
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, path);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      /* 临时文件可能没写出来 */
    }
    invalid('文件写不进去');
  }
}

function saveConfig(path: string, config: Json): void {
  backup(path);
  writeAtomic(path, `${JSON.stringify(config, null, 2)}\n`);
}

/** 只改这一行的值，保留缩进和行尾注释。 */
function replaceLineValue(raw: string, key: string, value: string): string | null {
  const cr = raw.endsWith('\r') ? '\r' : '';
  const m = new RegExp(`^(\\s*${key}:\\s*)([^\\s#]*)(.*)$`).exec(cr ? raw.slice(0, -1) : raw);
  return m ? `${m[1]}${value}${m[3]}${cr}` : null;
}

function setDsh(
  config: Json,
  role: C.RelayModelRole,
  value: string | null,
  magpie: MagpieModels,
): void {
  const key =
    role === 'developer'
      ? 'developer'
      : role === 'reviewerSubstitute'
        ? 'reviewer'
        : 'integratorSubstitute';
  const path = patchPath(argvOf(config, key));
  if (!path || !existsSync(path)) invalid('这个角色的补丁文件读不懂');
  const patch = readPatch(path, magpie);
  const [provider, model] = (value ?? '').split(' / ');
  if (!patch.ok || !provider || !model || !patch.options.includes(value!))
    invalid('这个选项不在补丁登记的模型里');

  const raw = readFileSync(path, 'utf8');
  const lines = raw.split('\n');
  const range = itemRange(lines, 'agent-default-model');
  if (!range) invalid('补丁文件读不懂');
  let pDone = false;
  let mDone = false;
  for (let i = range!.start + 1; i < range!.end && !(pDone && mDone); i++) {
    const b = noCr(lines[i]!);
    if (!pDone && /^\s*provider:/.test(b)) {
      const next = replaceLineValue(lines[i]!, 'provider', provider);
      if (next === null) invalid('补丁里找不到默认模型的 provider / model');
      lines[i] = next!;
      pDone = true;
    } else if (!mDone && /^\s*model:/.test(b)) {
      const next = replaceLineValue(lines[i]!, 'model', model);
      if (next === null) invalid('补丁里找不到默认模型的 provider / model');
      lines[i] = next!;
      mDone = true;
    }
  }
  if (!pDone || !mDone) invalid('补丁里找不到默认模型的 provider / model');
  const next = lines.join('\n');
  if (next === raw) return;
  backup(path);
  writeAtomic(path, next);
}

function setIntegrator(
  config: Json,
  path: string,
  value: string | null,
  magpie: MagpieModels,
  magpieBase: string | null,
): void {
  const integrator = rec(rec(config.roles)?.integrator);
  const argv = integrator?.argv;
  if (!Array.isArray(argv)) invalid('读不懂调度器配置里的整合方命令行');
  const isDefault = value === null || value === '' || value === DEFAULT_INTEGRATOR;
  const isAlias = value !== null && INTEGRATOR_OPTIONS.includes(value);
  const isMagpie = value !== null && magpie.models.includes(value);
  if (!isDefault && !isAlias && !isMagpie)
    invalid('整合方只能选 默认 / opus / sonnet / haiku，或 magpie 清单里的模型 / 分组');
  const next = [...(argv as unknown[])];
  const at = next.indexOf('--model');
  const insertAt = at >= 0 ? at : next.length;
  if (at >= 0) next.splice(at, at + 1 < next.length ? 2 : 1);
  if (value !== null && isAlias && value !== DEFAULT_INTEGRATOR)
    next.splice(insertAt, 0, '--model', value);
  let changed = JSON.stringify(next) !== JSON.stringify(argv);
  integrator!.argv = next;
  // MG2：选了 magpie 的模型 / 分组就记在 magpieModel，起棒时由调度器加环境变量和 --model；
  // 选「默认」/ Claude 自己的别名时把它清掉。
  if (isMagpie) {
    if (integrator!.magpieModel !== value) {
      integrator!.magpieModel = value;
      changed = true;
    }
    if (magpieBase && integrator!.magpieUrl !== magpieBase) {
      integrator!.magpieUrl = magpieBase;
      changed = true;
    }
  } else if (isDefault || isAlias) {
    if ('magpieModel' in integrator!) {
      delete integrator!.magpieModel;
      changed = true;
    }
    if ('magpieUrl' in integrator!) {
      delete integrator!.magpieUrl;
      changed = true;
    }
  }
  if (!changed) return;
  saveConfig(path, config);
}

function setReviewer(
  config: Json,
  path: string,
  value: string | null,
  magpie: MagpieModels,
  magpieBase: string | null,
): void {
  const review = rec(config.review) ?? {};
  const isDefault = value === null || value === '' || value === '默认';
  const isMagpie = value !== null && magpie.models.includes(value);
  const next = isDefault ? null : value;
  if (!isDefault && !isMagpie && !/^[A-Za-z0-9._-]+$/.test(next!))
    invalid('Codex 模型名只能用字母、数字、.、-、_');
  const before = JSON.stringify(review);
  if (isMagpie) {
    review.magpieModel = value;
    if (magpieBase) review.magpieUrl = magpieBase;
    delete review.codexModel;
  } else if (isDefault) {
    delete review.codexModel;
    delete review.magpieModel;
    delete review.magpieUrl;
  } else {
    review.codexModel = next!;
    delete review.magpieModel;
    delete review.magpieUrl;
  }
  if (JSON.stringify(review) === before) return;
  config.review = review;
  saveConfig(path, config);
}

/** 改一个角色用的模型；值必须在 readRelayModels 的 options 里（审查按字符规则）。 */
export function setRelayModel(
  opts: {
    relayDir: string;
    /** MG2：面板刚取到的 magpie 清单；没传就只认原来的选项。 */
    magpieModels?: string[];
    /** MG2：清单是从哪个本机地址取的，选 magpie 时记下来给调度器起角色用。 */
    magpieBase?: string | null;
  },
  input: { role: C.RelayModelRole; value: string | null },
): void {
  if (!ROLES.includes(input.role)) invalid('不认识的角色');
  const path = join(dirOf(opts.relayDir), 'config.json');
  const config = loadJson(path);
  if (!config) invalid('读不到调度器配置');
  const magpie: MagpieModels = { models: opts.magpieModels ?? [], error: null };
  if (input.role === 'integrator')
    setIntegrator(config!, path, input.value, magpie, opts.magpieBase ?? null);
  else if (input.role === 'reviewer')
    setReviewer(config!, path, input.value, magpie, opts.magpieBase ?? null);
  else setDsh(config!, input.role, input.value, magpie);
}
