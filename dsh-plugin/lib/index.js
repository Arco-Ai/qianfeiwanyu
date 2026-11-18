// 千肥万鱼 · DSH 联动桥（宿主半边）
//
// 作用：住在 DSH 进程里，监听会话/Agent 的状态变化，经本机回环（127.0.0.1）
// 推给「千肥万鱼」桌面观察台的本地服务，让鲸鱼娘立绘的表情与台词跟着
// Agent 的工作状态走。只发状态信号，不读、不写 DSH 的任何业务数据。
//
// 设计要点：
//   - 只认本机：目标固定 127.0.0.1，端口默认 18765（可在 cordis.patch.yml 改）。
//   - 不碰内核：所有事件订阅都放进 ctx.effect，插件卸载时自动退订。
//   - 兼容不同 DSH 版本：事件名做了多套兜底，缺失的服务一律 try/catch 跳过，
//     缺服务不会让插件崩溃，只是少几种联动。
//   - 节流：同一状态在最小间隔内只推一次，避免流式刷新把观察台刷爆。

import { join } from 'node:path'
import { homedir } from 'node:os'
import { writeFileSync } from 'node:fs'

export const name = 'qianfeiwanyu-bridge'
export const inject = ['agents', 'webServer']

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const PATH_STATE = join(DSH_HOME, 'qianfeiwanyu-bridge-state.json')

const DEFAULT = { port: 18765, enabled: true, speak: true, minIntervalMs: 1200 }
let cfg = { ...DEFAULT }

function log(...a) { try { console.log('[千肥万鱼桥]', ...a) } catch (e) {} }

function num(v, d, lo, hi) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d
}

function applyConfig(input) {
  cfg = {
    port: num(input && input.port, DEFAULT.port, 1, 65535),
    enabled: input && input.enabled !== false,
    speak: !input || input.speak !== false,
    minIntervalMs: num(input && input.minIntervalMs, DEFAULT.minIntervalMs, 200, 10000),
  }
}

/** 把状态推送给千肥万鱼。同步写一份状态文件，便于观察台没开时也能看到最后一次状态。 */
let lastSent = { state: '', at: 0 }
function push(state, detail) {
  if (!cfg.enabled) return
  state = String(state || 'idle')
  const now = Date.now()
  if (state === lastSent.state && now - lastSent.at < cfg.minIntervalMs) return
  lastSent = { state, at: now }
  const payload = {
    app: 'qianfeiwanyu-bridge',
    state,
    detail: String(detail || '').slice(0, 300),
    speak: !!cfg.speak,
    at: now,
  }
  // 落盘一份（排障 / 观察台离线时补读），同步写、不用 await
  try { writeFileSync(PATH_STATE, JSON.stringify(payload), 'utf8') } catch (e) { /* 忽略 */ }

  // 本机回环推送（fire-and-forget，不阻塞事件回调）
  try {
    const url = `http://127.0.0.1:${cfg.port}/api/dsh/agent-state`
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(1500),
    }).then(r => { if (!r.ok) log('推送返回', r.status) }).catch(() => {})
  } catch (e) {
    // 观察台没开是常态，静默即可，别刷屏
  }
}

export function apply(ctx, config) {
  applyConfig(config)
  log('已加载，目标 127.0.0.1:' + cfg.port)

  // 监听配置热更新（若 DSH 版本支持）
  try {
    ctx.on('config', (next) => { applyConfig(next); log('配置已更新 → 端口', cfg.port) })
  } catch (e) {}

  const offs = []

  // 从 DSH 配置树里读状态（cordis.patch.yml 的 config 段），若存在则以它为准
  try {
    const fromTree = ctx.config && ctx.config.qianfeiwanyuBridge
    if (fromTree) applyConfig(fromTree)
  } catch (e) {}

  /**
   * 给某个 agent 挂一组事件。不同 DSH 版本的事件名不完全一致，
   * 这里全部订阅，缺失的不会触发，互不干扰。
   */
  function mount(agent) {
    const ac = agent && agent.ctx
    if (!ac || typeof ac.on !== 'function') return () => {}
    const local = []
    const on = (evt, fn) => {
      try { local.push(ac.on(evt, fn)) } catch (e) {}
    }

    // 一轮开始 / 工具执行 → 工作中
    on('agent/pre-step', () => push('working', '正在处理'))
    on('agent/turn-start', () => push('working', '开始干活了'))
    on('session/event', (ev) => {
      const t = ev && (ev.type || ev.kind || '')
      if (t === 'turn/start') push('working', '开始干活了')
      else if (t === 'turn/end' || t === 'turn/end ') push('celebrate', '这轮忙完了')
    })
    on('tools/pre-execute', (p) => {
      let name = ''
      try { name = p && p.tool && (p.tool.name || p.toolName) || p && p.name || '' } catch (e) {}
      push('working', name ? '调用工具 ' + name : '正在处理')
    })
    on('tools/execute', () => push('working', '正在处理'))

    // 收消息 → 期待
    on('agent/inbox/inserted', () => push('wait', '好像有新消息'))

    // 一轮收尾 / 停止 → 庆祝后回到 idle
    on('agent/turn-stopping', () => push('celebrate', '告一段落'))
    on('agent/turn-end', () => push('celebrate', '这轮忙完了'))

    // 出错 → 惊吓
    on('agent/error', (e) => push('error', (e && e.message ? String(e.message) : '出错了').slice(0, 120)))
    on('llm/error', (e) => push('error', (e && e.message ? String(e.message) : '出错了').slice(0, 120)))

    return () => { for (const f of local) { try { f() } catch (e) {} } }
  }

  const mounted = new Map()
  function syncAgents() {
    if (!cfg.enabled) return
    let list = []
    try { list = (ctx.agents && ctx.agents.list && ctx.agents.list()) || [] } catch (e) {}
    for (const a of list) {
      const key = a && a.session && (a.session.id || a.session.key || a.session.sessionId) || a
      if (mounted.has(key)) continue
      try { mounted.set(key, mount(a)) } catch (e) {}
    }
    for (const [key, off] of mounted) {
      const alive = list.some(a => (a && a.session && (a.session.id || a.session.key || a.session.sessionId) || a) === key)
      if (!alive) { try { off() } catch (e) {} mounted.delete(key) }
    }
  }

  syncAgents()
  try { ctx.effect(() => ctx.interval(syncAgents, 3000)) } catch (e) {
    log('定时器不可用，仅在加载时挂一次事件')
  }

  // 诊断路由：浏览器打开 /dsh-qianfeiwanyu/status 能看到桥是否活着
  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-qianfeiwanyu/status',
      handler: (req, res) => {
        try {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({
            ok: true, app: 'dsh-qianfeiwanyu', enabled: cfg.enabled,
            target: 'http://127.0.0.1:' + cfg.port + '/api/dsh/agent-state',
            last: lastSent, mounted: mounted.size,
          }))
        } catch (e) {}
      },
    }))
  } catch (e) { log('状态路由注册失败：' + (e && e.message)) }

  // 卸载时退订全部事件
  ctx.effect(() => () => {
    for (const off of mounted.values()) { try { off() } catch (e) {} }
    mounted.clear()
    log('已卸载')
  })
}
