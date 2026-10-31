/**
 * K5：手机只读页（规格 docs/委派/K5-手机只读页.md）。
 *
 * 独立监听 `127.0.0.1:<mobile.port>`，只提供 `GET /m`（内联 HTML）和
 * `GET /m/snapshot`（与桌面版同一个 `buildCockpitSnapshot`）。默认关，
 * 按设置项 `mobile.enabled` / `mobile.port` 起停；不绑 `0.0.0.0`，不访问主服务。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { buildCockpitSnapshot, getSetting, type CoreDatabase } from '@ixaeon/core';

export const DEFAULT_MOBILE_PORT = 43192;
const HOST = '127.0.0.1';

export interface MobileAddress {
  host: string;
  port: number;
}

/** 设置项 `mobile.enabled` / `mobile.port` 的读取口径（IPC 也用它）。 */
export function readMobileSettings(db: CoreDatabase): { enabled: boolean; port: number } {
  const enabled = getSetting(db, 'mobile.enabled')?.value === 'true';
  const raw = Number(getSetting(db, 'mobile.port')?.value ?? '');
  const port = Number.isInteger(raw) && raw >= 1 && raw <= 65535 ? raw : DEFAULT_MOBILE_PORT;
  return { enabled, port };
}

function splitHost(header: string): { name: string; port: string | null } | null {
  const value = header.trim().toLowerCase();
  if (!value || value.includes('[')) return null;
  const at = value.lastIndexOf(':');
  if (at < 0) return { name: value, port: null };
  if (value.indexOf(':') !== at) return null;
  return { name: value.slice(0, at), port: value.slice(at + 1) };
}

/** 防 DNS 重绑定：只认回环地址、localhost、或 tailnet 的 `…ts.net`。 */
function hostAllowed(header: string | undefined, port: number): boolean {
  if (!header) return false;
  const parsed = splitHost(header);
  if (!parsed) return false;
  if (parsed.port !== null && parsed.port !== String(port)) return false;
  if (parsed.name === '127.0.0.1' || parsed.name === 'localhost') return true;
  return parsed.name.endsWith('.ts.net');
}

function send(
  res: ServerResponse,
  status: number,
  body: string,
  type = 'text/plain; charset=utf-8',
): void {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

/** 手机页：样式和脚本都内联；四个视图由同一份快照渲染，每 60 秒刷新。 */
const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>IXAEON 驾驶舱</title><style>
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:#f6f7f9;color:#1c1f23}
header{position:sticky;top:0;z-index:2;display:flex;justify-content:space-between;align-items:baseline;gap:8px;padding:10px 12px;background:#fff;border-bottom:1px solid #e3e6ea}header strong{font-size:15px}
#updated{font-size:12px;color:#5b6470}#updated.stale{color:#c0392b;font-weight:600}
nav{display:grid;grid-template-columns:repeat(4, minmax(0, 1fr));gap:6px;padding:10px 12px}nav button{width:100%;padding:9px 2px;font:inherit;font-size:14px;color:#33404d;background:#fff;border:1px solid #d7dce2;border-radius:8px}nav button.active{color:#fff;background:#2f6feb;border-color:#2f6feb}
main{padding:0 12px 24px}section[data-view]{display:none}section[data-view].active{display:block}
.stats{display:grid;grid-template-columns:repeat(3, minmax(0, 1fr));gap:8px;margin:4px 0 14px}.stats div{padding:10px 8px;text-align:center;background:#fff;border:1px solid #e3e6ea;border-radius:10px}.stats b{display:block;font-size:22px;line-height:1.2}.stats span{font-size:12px;color:#5b6470}
h2{margin:14px 0 8px;font-size:15px}ul{list-style:none;margin:0;padding:0}li{padding:9px 10px;margin-bottom:6px;background:#fff;border:1px solid #e3e6ea;border-radius:10px}li .why{display:block;font-size:12px;color:#5b6470;margin-top:2px}.empty{color:#5b6470;font-size:13px}
</style></head><body>
<header><strong>IXAEON 驾驶舱</strong><span id="updated">正在读取… 分钟前更新</span></header>
<nav><button type="button" data-view-button="overview" class="active">总览</button><button type="button" data-view-button="waiting">等你处理</button><button type="button" data-view-button="quota">额度</button><button type="button" data-view-button="projects">项目</button></nav>
<main>
<section data-view="overview" class="active"><div class="stats"><div><b id="today-turns">–</b><span>今天完成</span></div><div><b id="running-count">–</b><span>进行中</span></div><div><b id="active-projects">–</b><span>活跃项目</span></div></div><h2>等你处理（前 3 条）</h2><ul id="overview-waiting"><li class="empty">读取中…</li></ul></section>
<section data-view="waiting"><h2>等你处理</h2><ul id="all-waiting"><li class="empty">读取中…</li></ul></section>
<section data-view="quota"><h2>额度</h2><p class="empty">额度信息还没接进驾驶舱；接上之后这里显示余额和用量。</p></section>
<section data-view="projects"><h2>项目</h2><ul id="project-list"><li class="empty">读取中…</li></ul></section>
</main>
<script>
(function(){
var latest=null,lastOk=0,failed=false;
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function tick(){var el=document.getElementById('updated');if(!lastOk){el.textContent='还没读到数据';el.className='stale';return;}var m=Math.floor((Date.now()-lastOk)/60000);el.textContent=m+' 分钟前更新';el.className=(failed||m>=2)?'stale':'';}
function waitingHtml(items,limit){var kinds={relay_down:'调度器不在了',turn_unfinished:'这一棒没跑完',relay_stale:'调度器可能停了',relay_stopped:'调度器停了',queue_user:'队列里等你拍板'};if(!items.length){return '<li class="empty">没有等你处理的事</li>';}return items.slice(0,limit).map(function(it){return '<li>'+esc(it.text)+'<span class="why">'+esc(kinds[it.kind]||it.kind)+(it.since?' · '+esc(it.since):'')+'</span></li>';}).join('');}
function projectsHtml(p){var groups=[['活跃',p.active],['暂停',p.paused],['归档',p.archived]],out=[];groups.forEach(function(g){if(!g[1].length)return;out.push('<li><b>'+esc(g[0])+'</b>');out.push(g[1].map(function(x){return '<div>'+esc(x.name)+'</div>';}).join(''));out.push('</li>');});return out.length?out.join(''):'<li class="empty">还没有项目</li>';}
function render(){if(!latest)return;document.getElementById('today-turns').textContent=String(latest.today.finishedTurns);document.getElementById('running-count').textContent=String(latest.running.length);document.getElementById('active-projects').textContent=String(latest.projects.active.length);document.getElementById('overview-waiting').innerHTML=waitingHtml(latest.attention,3);document.getElementById('all-waiting').innerHTML=waitingHtml(latest.attention,999);document.getElementById('project-list').innerHTML=projectsHtml(latest.projects);}
function refresh(){fetch('/m/snapshot',{cache:'no-store'}).then(function(r){if(!r.ok)throw new Error('bad status');return r.json();}).then(function(data){latest=data;lastOk=Date.now();failed=false;render();tick();}).catch(function(){failed=true;tick();});}
document.querySelector('nav').addEventListener('click',function(e){var b=e.target.closest('button[data-view-button]');if(!b)return;var name=b.getAttribute('data-view-button');document.querySelectorAll('nav button').forEach(function(x){x.classList.toggle('active',x===b);});document.querySelectorAll('section[data-view]').forEach(function(s){s.classList.toggle('active',s.getAttribute('data-view')===name);});});
setInterval(refresh, 60000);
setInterval(tick, 30000);
refresh();tick();
})();
</script>
</body></html>`;

export class MobileServer {
  private db: CoreDatabase;
  private running: { server: Server; port: number } | null = null;

  constructor(opts: { db: CoreDatabase }) {
    this.db = opts.db;
  }

  /** 数据恢复后重建运行时：换新库，不再拿旧的 db 引用。 */
  rebindDeps(opts: { db: CoreDatabase }): void {
    this.db = opts.db;
  }

  get address(): MobileAddress | null {
    return this.running ? { host: HOST, port: this.running.port } : null;
  }

  /** 按设置项起停；关着就停，端口变了就换。 */
  async apply(): Promise<void> {
    const { enabled, port } = readMobileSettings(this.db);
    if (!enabled) {
      await this.stop();
      return;
    }
    if (this.running?.port === port) return;
    await this.stop();
    await new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => {
        void this.handle(req, res, port);
      });
      server.once('error', (err) => {
        reject(
          new Error(
            `手机查看的端口 ${port} 起不来（可能被别的程序占了）：${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      });
      server.listen({ host: HOST, port }, () => {
        this.running = { server, port };
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const current = this.running;
    if (!current) return;
    this.running = null;
    await new Promise<void>((resolve) => current.server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse, port: number): Promise<void> {
    if (!hostAllowed(req.headers.host, port)) {
      return send(res, 421, '这个地址不允许访问手机页');
    }
    if (req.method !== 'GET') {
      return send(res, 405, '手机页只读，只支持 GET');
    }
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/m') {
      return send(res, 200, PAGE, 'text/html; charset=utf-8');
    }
    if (path === '/m/snapshot') {
      try {
        const snapshot = await buildCockpitSnapshot(this.db, {
          relayDir: '',
          ixaeonRepo: getSetting(this.db, 'cockpit.ixaeon_repo')?.value ?? '',
        });
        return send(res, 200, JSON.stringify(snapshot), 'application/json; charset=utf-8');
      } catch {
        return send(res, 500, '快照读取失败');
      }
    }
    return send(res, 404, '没有这个页面');
  }
}
