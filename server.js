'use strict';

/*
 * 千肥万鱼 · 后端
 *
 * 读写边界（重要）：
 *  - DSH 数据目录（默认 ~/.dsh，可用环境变量 DSH_ROOT 覆盖）只读：只有 readFileSync / statSync / readdirSync / createReadStream。
 *    唯一例外是用户明确点击「人格卡 → 保存到 DSH」时，写回当前 surfcore 角色的 persona.md；
 *    写入前先把原文备份到千肥万鱼自己的 data/persona-backups/，不会改动 DSH 的其他文件。
 *  - 本程序允许的写入仅限自身目录：settings.json、persona.json、assets.json、chat-log.json、
 *    assets/uploads/*、data/schedules/*、data/diaries/* 与 data/persona-backups/*。
 *    所有写路径都经过 localPath() 前缀校验，越界直接抛错；
 *    删除只允许 assets/uploads/* 与 data/schedules/* 内的文件。
 *  - 外部网络请求只在用户于界面主动点击「生成立绘」/「朗读」且已配置密钥时发生；
 *    页面加载、自动刷新、快照读取都不会联网。浏览器只与 127.0.0.1 通信，由本服务代理。
 *  - 服务只绑定 127.0.0.1，无外部端口暴露。
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFileSync, exec, spawn } = require('child_process');
const net = require('net');

/* DSH 数据目录：优先 DSH_ROOT，其次用户主目录下的 .dsh（换机器也能直接用） */
const ROOT = path.resolve(process.env.DSH_ROOT || path.join(os.homedir(), '.dsh')).replace(/\\/g, '/');
const PORT = Number(process.env.FISH_WATCH_PORT || 18765);
const HOST = '127.0.0.1';

/* ---------- 访问令牌 ----------
 * 服务只监听 127.0.0.1，但同一台机器上的其他账户、其他进程同样能连上这个端口。
 * 所以除「探活」与「DSH 插件读活动状态」外，所有 /api/ 都要求令牌：
 *   - 桌面版由主进程注入到页面地址的 #fw_token= 里，用户无感；
 *   - 源码/浏览器方式启动时，控制台会打印带令牌的地址，首次用它打开即可；
 *   - DSH 插件走 /api/dsh/agent-state，不受影响。
 * 令牌首次运行随机生成，存在用户主目录（不放程序目录：便携版换台机器不会带着别人的令牌走）。
 * 说明：这挡得住同机其他账户、端口转发暴露和盲目扫描；挡不住「同一账户下已在你机器上跑起来
 * 的恶意程序」——那种程序能直接读令牌文件，只能靠系统层面的防护。 */
const TOKEN_FILE = path.join(os.homedir(), '.fish-watch', 'api-token');
function loadApiToken() {
  const fromEnv = String(process.env.FISH_WATCH_TOKEN || '').trim();
  if (/^[A-Za-z0-9_-]{20,}$/.test(fromEnv)) return fromEnv;
  try {
    const old = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (/^[A-Za-z0-9_-]{20,}$/.test(old)) return old;
  } catch (e) { /* 首次运行 */ }
  const fresh = crypto.randomBytes(24).toString('base64url');
  try {
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(TOKEN_FILE, fresh + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch (e) { /* 主目录不可写：仅本次进程有效，桌面版从模块导出读取 */ }
  return fresh;
}
const API_TOKEN = loadApiToken();

function tokenMatches(got) {
  if (!got) return false;
  const a = Buffer.from(String(got), 'utf8');
  const b = Buffer.from(API_TOKEN, 'utf8');
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch (e) { return false; }
}
function requestToken(req, url) {
  const h = req.headers || {};
  const fromHeader = String(h['x-fw-token'] || '').trim();
  if (fromHeader) return fromHeader;
  const auth = String(h.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (auth) return auth;
  try { return String(url.searchParams.get('token') || '').trim(); } catch (e) { return ''; }
}
/* 免令牌：探活（桌面端判断端口上是不是自己）与 DSH 插件的活动状态。
 * 插件跑在 DSH 进程里、只推表情状态（GET 读 / POST 推），拿不到页面里的令牌，
 * 所以这两个接口保持开放：它们不读写任何会话内容，最坏后果是表情被乱切。 */
function tokenExempt(method, p) {
  if (p === '/api/dsh/agent-state') return true;
  if (method !== 'GET' && method !== 'HEAD') return false;
  return p === '/api/health';
}

/* 本地接口防护：只接受本机页面 / 本机脚本的请求，挡住跨站伪造（CSRF）。
 * - 浏览器跨站 POST 一定带外来 Origin / Sec-Fetch-Site: cross-site，据此拒绝；
 * - 桌面版同源请求 Origin 是 http://127.0.0.1:<任意端口>，属本机，放行；
 * - DSH 插件、curl 等本机脚本通常不带 Origin / Sec-Fetch-Site，放行。 */
function localRequestGuard(req, res) {
  const h = req.headers || {};
  const origin = h.origin;
  if (origin) {
    let ok = false;
    try {
      const u = new URL(origin);
      const host = (u.hostname || '').toLowerCase();
      ok = (host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1');
    } catch (e) { ok = false; }
    if (!ok) {
      sendJson(res, 403, { ok: false, error: '拒绝外来来源的请求' });
      return false;
    }
  }
  const site = h['sec-fetch-site'];
  if (site === 'cross-site') {
    sendJson(res, 403, { ok: false, error: '拒绝跨站请求' });
    return false;
  }
  return true;
}

const CACHE_MS = 2500;
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
const MAX_BODY_BYTES = 18 * 1024 * 1024;
let APP_VERSION = '1.0.0';
try { APP_VERSION = require('./package.json').version || APP_VERSION; } catch (e) { /* 无 package.json 时用默认值 */ }

const APP_DIR = path.resolve(__dirname);
const ASSETS_DIR = path.join(APP_DIR, 'assets');
const UPLOADS_DIR = path.join(ASSETS_DIR, 'uploads');
const DIARY_DIR = path.join(APP_DIR, 'data/diaries');

const at = (rel) => path.join(ROOT, rel);
const round = (n, d = 1) => Math.round(Number(n) * Math.pow(10, d)) / Math.pow(10, d);
const iso = (v) => {
  if (typeof v === 'number' && v > 0) return new Date(v).toISOString();
  if (typeof v === 'string' && v) return v;
  return null;
};

/* ---------- 本地写入的唯一出口 ---------- */

function localPath(rel) {
  const p = path.resolve(APP_DIR, rel);
  if (p !== APP_DIR && !p.startsWith(APP_DIR + path.sep)) {
    throw new Error('写入路径越界：' + rel);
  }
  return p;
}
function ensureLocalDirs() {
  fs.mkdirSync(localPath('assets/uploads'), { recursive: true });
  fs.mkdirSync(localPath('data/schedules'), { recursive: true });
  fs.mkdirSync(localPath('data/diaries'), { recursive: true });
  fs.mkdirSync(localPath('data/persona-backups'), { recursive: true });
}
/* 敏感写操作的轻量审计：只记「谁在什么时候改了哪个文件」，不记内容本身 */
const SECURITY_LOG = localPath('data/security.log');
function securityLog(action, detail) {
  try {
    const line = JSON.stringify(Object.assign({ at: new Date().toISOString(), action }, detail || {}));
    fs.appendFileSync(SECURITY_LOG, line + '\n', 'utf8');
    if (fs.statSync(SECURITY_LOG).size > 512 * 1024) {
      const keep = fs.readFileSync(SECURITY_LOG, 'utf8').split('\n').filter(Boolean).slice(-500).join('\n');
      fs.writeFileSync(SECURITY_LOG, keep + '\n', 'utf8');
    }
  } catch (e) { /* 记日志失败不影响主流程 */ }
}

/* ---------- 设置 ---------- */

const DEFAULT_SETTINGS = {
  petName: '',
  characterName: '',
  ownerName: '',
  chatName: '',
  portrait: '',
  tts: { enabled: false, autoRead: false, engine: 'browser', voice: '', rate: 1, pitch: 1, volume: 1 },
  image: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-image-1', size: '1024x1024', responseFormat: 'b64_json' },
  serverTts: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'tts-1', voice: 'alloy', format: 'mp3' },
  sovits: {
    baseUrl: 'http://127.0.0.1:9880',
    refAudioPath: '',
    promptText: '',
    promptLang: 'zh',
    textLang: 'zh',
    speed: 1,
    topK: 5,
    topP: 1,
    temperature: 1,
    splitMethod: 'cut5',
    batchSize: 1,
    mediaType: 'wav',
    streaming: false,
    timeoutSec: 120,
    autoStart: false,     /* 默认不自动拉起：本机脚本属于可执行文件，交给用户点了才启动 */
  },
  chat: {
    dshBaseUrl: 'http://127.0.0.1:3080/m/api',
    dshSessionId: '',
    dshToken: '',
    replyTimeoutSec: 100,
  },
  schedule: {
    enabled: true,        /* 按每日日程自动切背景 / 时段 / 立绘心情 */
    driveScene: true,     /* 用日程地点挑场景 */
    driveSlot: true,      /* 用日程时间挑时段（白天/傍晚/夜晚） */
    drivePortrait: true,  /* 用日程活动挑立绘心情（idle/happy/sad） */
    source: 'auto',       /* auto / fishwatch / dsh / manual */
    autoGenerate: true,   /* 没有日程时，千肥万鱼本地生成一份 */
  },
  diary: {
    enabled: true,        /* 到点自动写日记 */
    time: '21:00',        /* 现实时间，24 小时制 */
    maxDays: 180,         /* 本地最多保留多少篇 */
  },
};

const str = (v, max, fallback) => (typeof v === 'string' ? v.slice(0, max) : fallback);
const num = (v, min, max, fallback) => (typeof v === 'number' && isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback);
const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
const oneOf = (v, list, fallback) => (list.indexOf(v) >= 0 ? v : fallback);

/* GPT-SoVITS 的取值域，前后端共用同一套，非法值一律回落到默认 */
const SOVITS_LANGS = ['zh', 'ja', 'en', 'ko', 'yue', 'auto'];
const SOVITS_SPLIT = ['cut0', 'cut1', 'cut2', 'cut3', 'cut4', 'cut5'];
const SOVITS_MEDIA = ['wav', 'mp3', 'aac', 'ogg'];
const SOVITS_CT = { wav: 'audio/wav', mp3: 'audio/mpeg', aac: 'audio/aac', ogg: 'audio/ogg' };
const SCHEDULE_SOURCES = ['auto', 'fishwatch', 'dsh', 'manual'];
const SCHEDULE_SOURCE_LABEL = {
  auto: '自动（优先千肥万鱼，兼容 DSH）',
  fishwatch: '千肥万鱼自有日程',
  dsh: 'DSH 日程插件',
  manual: '手动编辑日程',
};

function normalizeSovits(raw, base) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const b = base || DEFAULT_SETTINGS.sovits;
  return {
    baseUrl: str(r.baseUrl, 300, b.baseUrl) || b.baseUrl,
    refAudioPath: str(r.refAudioPath, 520, b.refAudioPath || ''),
    promptText: str(r.promptText, 1000, b.promptText || ''),
    promptLang: oneOf(r.promptLang, SOVITS_LANGS, b.promptLang),
    textLang: oneOf(r.textLang, SOVITS_LANGS, b.textLang),
    speed: num(r.speed, 0.5, 2, b.speed),
    topK: num(r.topK, 1, 30, b.topK),
    topP: num(r.topP, 0.1, 1, b.topP),
    temperature: num(r.temperature, 0.1, 2, b.temperature),
    splitMethod: oneOf(r.splitMethod, SOVITS_SPLIT, b.splitMethod),
    batchSize: num(r.batchSize, 1, 20, b.batchSize),
    mediaType: oneOf(r.mediaType, SOVITS_MEDIA, b.mediaType),
    streaming: bool(r.streaming, b.streaming),
    timeoutSec: num(r.timeoutSec, 10, 300, b.timeoutSec),
    autoStart: bool(r.autoStart, b.autoStart),
  };
}

function mergeSettings(body, cur) {
  const b = body && typeof body === 'object' ? body : {};
  const c = cur || DEFAULT_SETTINGS;
  const t = b.tts && typeof b.tts === 'object' ? b.tts : {};
  const i = b.image && typeof b.image === 'object' ? b.image : {};
  const st = b.serverTts && typeof b.serverTts === 'object' ? b.serverTts : {};
  const ci = c.image || DEFAULT_SETTINGS.image;
  const cs = c.serverTts || DEFAULT_SETTINGS.serverTts;
  const ct = c.tts || DEFAULT_SETTINGS.tts;
  const cv = c.sovits || DEFAULT_SETTINGS.sovits;
  const ch = b.chat && typeof b.chat === 'object' ? b.chat : {};
  const cc = c.chat || DEFAULT_SETTINGS.chat;
  const sd = b.schedule && typeof b.schedule === 'object' ? b.schedule : {};
  const cd = c.schedule || DEFAULT_SETTINGS.schedule;
  const dy = b.diary && typeof b.diary === 'object' ? b.diary : {};
  const cy = c.diary || DEFAULT_SETTINGS.diary;

  let portrait = str(b.portrait, 160, c.portrait || '');
  if (portrait && !/^(?:uploads\/)?[\u4e00-\u9fa5A-Za-z0-9._-]+$/.test(portrait)) portrait = '';

  const s = {
    petName: str(b.petName, 64, c.petName || ''),
    characterName: str(b.characterName, 64, c.characterName || ''),
    ownerName: str(b.ownerName, 64, c.ownerName || ''),
    chatName: str(b.chatName, 64, c.chatName || ''),
    portrait,
    tts: {
      enabled: bool(t.enabled, ct.enabled),
      autoRead: bool(t.autoRead, ct.autoRead),
      stripActions: t.stripActions === undefined ? ct.stripActions !== false : !!t.stripActions,
      engine: oneOf(t.engine, ['browser', 'server', 'sovits'], ct.engine),
      voice: str(t.voice, 200, ct.voice || ''),
      rate: num(t.rate, 0.5, 2, ct.rate),
      pitch: num(t.pitch, 0, 2, ct.pitch),
      volume: num(t.volume, 0, 1, ct.volume),
    },
    image: {
      baseUrl: str(i.baseUrl, 300, ci.baseUrl),
      apiKey: typeof i.apiKey === 'string' && i.apiKey ? i.apiKey.slice(0, 600) : (ci.apiKey || ''),
      model: str(i.model, 120, ci.model),
      size: str(i.size, 40, ci.size),
      responseFormat: oneOf(i.responseFormat, ['b64_json', 'url'], ci.responseFormat),
    },
    serverTts: {
      baseUrl: str(st.baseUrl, 300, cs.baseUrl),
      apiKey: typeof st.apiKey === 'string' && st.apiKey ? st.apiKey.slice(0, 600) : (cs.apiKey || ''),
      model: str(st.model, 120, cs.model),
      voice: str(st.voice, 80, cs.voice),
      format: oneOf(st.format, ['mp3', 'wav', 'opus', 'aac', 'flac'], cs.format),
    },
    sovits: normalizeSovits(b.sovits, cv),
    chat: {
      dshBaseUrl: str(ch.dshBaseUrl, 300, cc.dshBaseUrl),
      dshSessionId: str(ch.dshSessionId, 160, cc.dshSessionId || ''),
      dshToken: ch.clearDshToken ? '' : (typeof ch.dshToken === 'string' && ch.dshToken ? ch.dshToken.slice(0, 200) : (cc.dshToken || '')),
      replyTimeoutSec: num(ch.replyTimeoutSec, 20, 300, cc.replyTimeoutSec),
    },
    schedule: {
      enabled: bool(sd.enabled, cd.enabled),
      driveScene: bool(sd.driveScene, cd.driveScene),
      driveSlot: bool(sd.driveSlot, cd.driveSlot),
      drivePortrait: bool(sd.drivePortrait, cd.drivePortrait),
      source: oneOf(sd.source, SCHEDULE_SOURCES, cd.source),
      autoGenerate: bool(sd.autoGenerate, cd.autoGenerate),
    },
    diary: {
      enabled: bool(dy.enabled, cy.enabled),
      time: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(dy.time || '')) ? String(dy.time) : cy.time,
      maxDays: num(dy.maxDays, 30, 730, cy.maxDays),
    },
  };
  if (b._clearImageKey === true) s.image.apiKey = '';
  if (b._clearTtsKey === true) s.serverTts.apiKey = '';
  return s;
}

function loadSettings() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(localPath('settings.json'), 'utf8')); }
  catch (e) { raw = {}; }
  return mergeSettings(raw, DEFAULT_SETTINGS);
}
function saveSettings(s) {
  fs.writeFileSync(localPath('settings.json'), JSON.stringify(s, null, 2) + '\n', 'utf8');
  return s;
}
function publicSettings(s) {
  const out = JSON.parse(JSON.stringify(s));
  out.image.apiKeySet = !!out.image.apiKey;
  out.serverTts.apiKeySet = !!out.serverTts.apiKey;
  out.chat.dshTokenSet = !!out.chat.dshToken;
  out.image.apiKey = '';
  out.serverTts.apiKey = '';
  out.chat.dshToken = '';
  out.capabilities = {
    browserTts: true,
    serverTts: !!(s.serverTts.apiKey || process.env.FISH_TTS_API_KEY),
    sovits: !!(s.sovits && s.sovits.baseUrl),
    imageGen: !!(s.image.apiKey || process.env.FISH_IMAGE_API_KEY),
    chat: true,
    schedule: true,
  };
  return out;
}

let SETTINGS = loadSettings();

/* ---------- 人格卡（本机上传，解析不联网、不调模型） ---------- */

const MAX_CARD_BYTES = 8 * 1024 * 1024;
const PERSONA_FILE = localPath('persona.json');
const DEFAULT_PERSONA = { activeId: '', apply: { name: true, owner: true, greeting: true, style: true }, cards: [] };

const cut = (v, max) => {
  if (typeof v === 'string') return v.slice(0, max);
  if (v == null) return '';
  return String(v).slice(0, max);
};
function cardField(o, keys, max) {
  for (const k of keys) {
    if (o && typeof o[k] === 'string' && o[k].trim()) return cut(o[k].trim(), max);
  }
  return '';
}
function normalizeCard(raw, filename, format) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const src = o.data && typeof o.data === 'object' ? o.data
    : (o.character && typeof o.character === 'object' ? o.character : o);
  return {
    name: cardField(src, ['name', 'character_name', 'Name', '名字', '角色名'], 120),
    description: cardField(src, ['description', 'persona', 'Description', '设定', '人设', '简介'], 8000),
    personality: cardField(src, ['personality', 'Personality', '性格', '性格设定'], 4000),
    scenario: cardField(src, ['scenario', 'Scenario', '背景', '场景'], 4000),
    firstMes: cardField(src, ['first_mes', 'first_message', 'greeting', 'Greeting', '开场白', '初次问候'], 4000),
    mesExample: cardField(src, ['mes_example', 'example_dialogue', '示例对话', '对话示例'], 4000),
    systemPrompt: cardField(src, ['system_prompt', 'system', '系统提示'], 4000),
    creatorNotes: cardField(src, ['creator_notes', 'creator', '备注', '作者备注'], 4000),
    ownerName: cardField(src, ['owner_name', 'ownerName', 'owner', 'user_name', '主人', '称呼'], 120),
    tags: Array.isArray(src.tags) ? src.tags.slice(0, 30).map((t) => cut(t, 40)) : [],
    spec: cut(o.spec || o.spec_version || '', 60),
    filename: cut(filename, 160),
    format,
  };
}
function parseTextCard(text, filename) {
  const t = String(text).slice(0, 200000);
  const pick = (re, max) => { const x = re.exec(t); return x ? cut(x[1].trim(), max) : ''; };
  const c = normalizeCard({}, filename, 'text');
  c.name = pick(/^\s*#\s+(.+)$/m, 120)
    || pick(/(?:^|\n)\s*(?:name|Name|名字|角色名)\s*[:：]\s*(.+)/, 120)
    || cut(filename.replace(/\.[^.]+$/, ''), 120);
  c.ownerName = pick(/(?:^|\n)\s*(?:owner|ownerName|Owner|user|User|主人|称呼)\s*[:：]\s*(.+)/, 120);
  c.description = cut(t, 8000);
  c.personality = pick(/(?:^|\n)#{1,4}\s*(?:性格|性格设定|Personality)[^\n]*\n([\s\S]{0,4000}?)(?=\n#{1,4}\s|$)/i, 4000);
  c.scenario = pick(/(?:^|\n)#{1,4}\s*(?:场景|背景|世界观|Scenario)[^\n]*\n([\s\S]{0,4000}?)(?=\n#{1,4}\s|$)/i, 4000);
  c.firstMes = pick(/(?:^|\n)#{1,4}\s*(?:开场白|初次问候|第一句|First Message|Greeting)[^\n]*\n([\s\S]{0,4000}?)(?=\n#{1,4}\s|$)/i, 4000);
  c.mesExample = pick(/(?:^|\n)#{1,4}\s*(?:示例对话|对话示例|Example)[^\n]*\n([\s\S]{0,4000}?)(?=\n#{1,4}\s|$)/i, 4000);
  return c;
}
function parsePngCard(buf) {
  if (!(buf.length > 8 && buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG')) return null;
  let off = 8;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    if (len > buf.length - off - 12) break;
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      const z = data.indexOf(0);
      if (z > 0) {
        const kw = data.slice(0, z).toString('latin1').toLowerCase();
        if (kw === 'chara' || kw === 'ccv3') {
          let val = '';
          try {
            if (type === 'tEXt') val = data.slice(z + 1).toString('latin1');
            else if (type === 'zTXt') val = zlib.inflateSync(data.slice(z + 2)).toString('latin1');
            else { const parts = data.slice(z + 1).toString('latin1').split('\0'); val = parts[parts.length - 1] || ''; }
            let parsed = null;
            try { parsed = JSON.parse(val); }
            catch (e) { try { parsed = JSON.parse(Buffer.from(val.replace(/\s/g, ''), 'base64').toString('utf8')); } catch (e2) { /* not a card */ } }
            if (parsed && typeof parsed === 'object') return parsed;
          } catch (e) { /* 损坏的元数据块，跳过 */ }
        }
      }
    }
    off += 12 + len;
    if (type === 'IEND') break;
  }
  return null;
}
function parseCard(buf, filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.png') {
    const j = parsePngCard(buf);
    if (j) {
      const c = normalizeCard(j, filename, 'png-v2');
      if (!c.name) c.name = cut(filename.replace(/\.[^.]+$/, ''), 120);
      return c;
    }
  }
  const head = buf.slice(0, 64).toString('utf8').replace(/^\uFEFF/, '').trim();
  if (ext === '.json' || head[0] === '{' || head[0] === '[') {
    try {
      const j = JSON.parse(buf.toString('utf8'));
      const c = normalizeCard(j, filename, j && (j.spec || j.spec_version) ? 'char-v2' : 'char-v1');
      if (!c.name) c.name = cut(filename.replace(/\.[^.]+$/, ''), 120);
      return c;
    } catch (e) { throw httpError(400, 'JSON 人格卡格式不合法：' + e.message); }
  }
  return parseTextCard(buf.toString('utf8'), filename);
}
function loadPersona() {
  let d = {};
  try { d = JSON.parse(fs.readFileSync(PERSONA_FILE, 'utf8')); } catch (e) { d = {}; }
  const cards = Array.isArray(d.cards)
    ? d.cards.filter((c) => c && typeof c === 'object' && typeof c.id === 'string').slice(-50) : [];
  const apply = Object.assign({}, DEFAULT_PERSONA.apply, d.apply || {});
  for (const k of Object.keys(DEFAULT_PERSONA.apply)) apply[k] = !!apply[k];
  const activeId = cards.some((c) => c.id === d.activeId) ? d.activeId : '';
  return { activeId, apply, cards };
}
function savePersona(p) {
  fs.writeFileSync(PERSONA_FILE, JSON.stringify(p, null, 2) + '\n', 'utf8');
  cache = { at: 0, value: null };
  return p;
}
function activeCard(p) { return p.cards.find((c) => c.id === p.activeId) || null; }
function publicPersona(p) {
  return {
    ok: true, activeId: p.activeId, apply: p.apply, active: activeCard(p),
    cards: p.cards.map((c) => ({ id: c.id, name: c.name, filename: c.filename, format: c.format, spec: c.spec, tags: c.tags, createdAt: c.createdAt })),
  };
}
function decodeCardDataUrl(data) {
  const m = /^data:[^;,]*;base64,([A-Za-z0-9+/=\s]+)$/.exec(String(data || ''));
  if (!m) throw httpError(400, '请上传人格卡文件');
  const buf = Buffer.from(m[1].replace(/\s/g, ''), 'base64');
  if (!buf.length) throw httpError(400, '文件内容为空');
  if (buf.length > MAX_CARD_BYTES) throw httpError(413, '人格卡超过 8 MB 上限');
  return buf;
}
function addCard(buf, filename) {
  const card = parseCard(buf, cut(filename, 160));
  const p = loadPersona();
  const entry = Object.assign({ id: 'pc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7), createdAt: new Date().toISOString() }, card);
  p.cards.push(entry);
  p.cards = p.cards.slice(-50);
  p.activeId = entry.id;
  savePersona(p);
  return entry;
}
function updatePersona(body) {
  const p = loadPersona();
  const b = body && typeof body === 'object' ? body : {};
  if (b.action === 'delete') {
    const id = String(b.id || '');
    p.cards = p.cards.filter((c) => c.id !== id);
    if (p.activeId === id) p.activeId = p.cards.length ? p.cards[p.cards.length - 1].id : '';
  } else {
    if (typeof b.activeId === 'string') p.activeId = p.cards.some((c) => c.id === b.activeId) ? b.activeId : '';
    if (b.apply && typeof b.apply === 'object') {
      for (const k of Object.keys(DEFAULT_PERSONA.apply)) if (k in b.apply) p.apply[k] = !!b.apply[k];
    }
  }
  return savePersona(p);
}

/* ---------- DSH 当前人格：读取 + 用户确认后写回 persona.md ---------- */
/* 这里只碰 surfcore 的角色索引和 persona.md；不碰记忆、提示词、模型配置。 */
const DSH_CHAR_DIR = path.join(ROOT, 'surfcore/characters');
const VALID_CHAR_ID = /^char-[A-Za-z0-9_-]+$/;
const VALID_PERSONA_NAME = /^[A-Za-z0-9._-]+\.(?:md|txt)$/i;

function dshReadCharacterIndex() {
  const file = path.join(DSH_CHAR_DIR, 'index.json');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(j.characters) ? j.characters.filter((x) => x && VALID_CHAR_ID.test(String(x.id || ''))) : [];
  return { file, currentId: VALID_CHAR_ID.test(String(j.currentId || '')) ? String(j.currentId) : '', characters: list };
}
function dshPersonaTarget(id) {
  const idx = dshReadCharacterIndex();
  const want = VALID_CHAR_ID.test(String(id || '')) ? String(id) : idx.currentId;
  const meta = idx.characters.find((c) => c.id === want) || null;
  if (!meta) throw httpError(404, 'DSH 角色索引里没有这个人格：' + (want || '未指定'));
  const dir = path.resolve(DSH_CHAR_DIR, want);
  if (!dir.startsWith(path.resolve(DSH_CHAR_DIR) + path.sep)) throw httpError(400, '角色目录越界');
  const cj = JSON.parse(fs.readFileSync(path.join(dir, 'character.json'), 'utf8'));
  const fname = VALID_PERSONA_NAME.test(String(cj.persona || '')) ? String(cj.persona) : 'persona.md';
  const file = path.resolve(dir, fname);
  if (!file.startsWith(dir + path.sep)) throw httpError(400, '人格文件越界');
  return { idx, meta, cj, dir, file, fname, id: want };
}
function dshPersonaPayload(id) {
  const out = {
    ok: true, available: false, id: '', name: '', currentId: '', file: '', text: '',
    updatedAt: null, bytes: 0, chars: 0, characters: [], error: ''
  };
  try {
    const t = dshPersonaTarget(id);
    const buf = fs.readFileSync(t.file);
    const st = fs.statSync(t.file);
    out.available = true;
    out.id = t.id;
    out.currentId = t.idx.currentId;
    out.name = t.cj.name || t.meta.name || t.id;
    out.file = 'surfcore/characters/' + t.id + '/' + t.fname;
    out.text = buf.toString('utf8');
    out.bytes = st.size;
    out.chars = out.text.length;
    out.updatedAt = st.mtime.toISOString();
    out.characters = t.idx.characters.map((c) => ({ id: c.id, name: c.name || c.personaMeta && c.personaMeta.name || c.id, current: c.id === t.idx.currentId }));
  } catch (e) {
    out.error = e && e.message ? e.message : String(e);
  }
  return out;
}
function writeDshPersona(body) {
  const b = body && typeof body === 'object' ? body : {};
  const text = String(b.text == null ? '' : b.text);
  if (!text.trim()) throw httpError(400, '人格内容不能为空');
  if (text.length > 200000) throw httpError(413, '人格内容超过 20 万字上限');
  const t = dshPersonaTarget(b.id);
  const old = fs.readFileSync(t.file, 'utf8');
  if (b.expectUpdatedAt && String(b.expectUpdatedAt) !== fs.statSync(t.file).mtime.toISOString()) {
    throw httpError(409, 'DSH 人格文件刚刚被别处改过，请刷新后再保存，避免覆盖');
  }
  if (old === text) return Object.assign(dshPersonaPayload(t.id), { unchanged: true, backup: '' });
  /* 写 DSH 之前，先把原文备份到千肥万鱼自己的目录 */
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupName = t.id + '-' + stamp + (path.extname(t.file) || '.md');
  const backup = localPath('data/persona-backups/' + backupName);
  fs.writeFileSync(backup, old, 'utf8');
  fs.writeFileSync(t.file, text, 'utf8');
  return Object.assign(dshPersonaPayload(t.id), { unchanged: false, backup: 'data/persona-backups/' + backupName });
}

/* ---------- 日记：千肥万鱼自己的 data/diaries/*.json ---------- */
const VALID_DAY = /^\d{4}-\d{2}-\d{2}$/;
function validDayKey(s) { return VALID_DAY.test(String(s || '')) && !isNaN(Date.parse(String(s) + 'T00:00:00Z')); }
function diaryFile(day) { return localPath('data/diaries/' + day + '.json'); }
function diaryList() {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(DIARY_DIR); } catch (e) { return out; }
  names.filter((f) => VALID_DAY.test(f.replace(/\.json$/i, '')) && /\.json$/i.test(f)).sort().reverse().forEach((f) => {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(DIARY_DIR, f), 'utf8'));
      out.push({
        date: j.date || f.replace(/\.json$/i, ''), wroteAt: j.wroteAt || null,
        title: cut(j.title || '', 80), mood: j.mood == null ? null : round(j.mood, 1),
        weather: cut(j.weather || '', 40), chars: String(j.text || '').length,
        bond: j.bond == null ? null : j.bond, bytes: fs.statSync(path.join(DIARY_DIR, f)).size,
      });
    } catch (e) { /* 坏文件跳过，不影响其他日记 */ }
  });
  return out;
}
function saveDiaryEntry(body) {
  const b = body && typeof body === 'object' ? body : {};
  const day = String(b.date || dayKey(new Date()));
  if (!validDayKey(day)) throw httpError(400, '日期格式应为 YYYY-MM-DD');
  const text = String(b.text || '');
  if (!text.trim()) throw httpError(400, '日记内容不能为空');
  if (text.length > 200000) throw httpError(413, '这篇日记太长了（上限 20 万字）');
  const entry = {
    date: day,
    wroteAt: iso(b.wroteAt) || new Date().toISOString(),
    title: cut(b.title || '', 80),
    mood: typeof b.mood === 'number' && isFinite(b.mood) ? round(b.mood, 1) : null,
    weather: cut(b.weather || '', 40),
    schedule: cut(b.schedule || '', 120),
    bond: typeof b.bond === 'number' && isFinite(b.bond) ? round(b.bond, 0) : null,
    text: text,
    updatedAt: new Date().toISOString(),
  };
  const file = diaryFile(day);
  const tmp = file + '.tmp';
  /* 目录可能被手动清理过，写入前确保存在（启动时的 mkdir 只跑一次，运行期删掉就不会重建） */
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (e) { /* ignore */ }
  fs.writeFileSync(tmp, JSON.stringify(entry, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  const max = num((SETTINGS.diary || {}).maxDays, 30, 730, DEFAULT_SETTINGS.diary.maxDays);
  const old = diaryList().slice(max).map((x) => x.date);
  old.forEach((d) => { try { fs.unlinkSync(diaryFile(d)); } catch (e) { /* ignore */ } });
  return { ok: true, entry: entry, pruned: old.length };
}

/* ---------- 快照（.dsh 只读） ---------- */

function readJson(rel, errors) {
  try { return JSON.parse(fs.readFileSync(at(rel), 'utf8')); }
  catch (e) { errors.push(rel + ' : ' + e.message); return null; }
}
function fileStat(rel) {
  try {
    const s = fs.statSync(at(rel));
    return { bytes: s.size, mtime: s.mtime.toISOString(), ageMin: round((Date.now() - s.mtimeMs) / 60000, 1) };
  } catch (e) { return { bytes: 0, mtime: null, ageMin: null }; }
}
function tail(rel, maxBytes, maxLines) {
  const p = at(rel);
  let st;
  try { st = fs.statSync(p); } catch (e) { return { lines: [], bytes: 0, mtime: null }; }
  const start = Math.max(0, st.size - maxBytes);
  const len = st.size - start;
  if (len <= 0) return { lines: [], bytes: st.size, mtime: st.mtime.toISOString() };
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(p, 'r');
  try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
  let text = buf.toString('utf8');
  if (start > 0) { const i = text.indexOf('\n'); if (i >= 0) text = text.slice(i + 1); }
  const lines = text.split(/\r?\n/).filter((x) => x.trim().length).slice(-maxLines);
  return { lines, bytes: st.size, mtime: st.mtime.toISOString() };
}

let procCache = { at: 0, value: null };
function processes() {
  if (procCache.value && Date.now() - procCache.at < 30000) return procCache.value;
  let value;
  try {
    const out = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], {
      encoding: 'utf8', timeout: 8000, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
    });
    value = {
      checked: true,
      harness: /DeepSeek Harness\.exe/i.test(out),
      electron: (out.match(/"electron\.exe"/gi) || []).length,
    };
  } catch (e) { value = { checked: false, harness: null, electron: null, error: e.message }; }
  procCache = { at: Date.now(), value };
  return value;
}

const WATCHED = [
  ['心情状态', 'feiyu-mood/state.json'],
  ['心情日志', 'feiyu-mood/diag.log'],
  ['桌宠日志', 'dsh-pet/logs.txt'],
  ['记忆诊断', 'fish-memory-diag.log'],
  ['主动搭话记录', 'daily-nudge.json'],
  ['配置补丁', 'profiles/desktop/cordis.patch.yml'],
  ['插件清单', 'profiles/desktop/package.json'],
];

function buildSnapshot() {
  const errors = [];
  const moodRaw = readJson('feiyu-mood/state.json', errors) || {};
  const moodCfg = readJson('feiyu-mood/config.json', errors) || {};
  const petCfg = readJson('dsh-pet/main-config.jsonc', errors) || {};
  const atriCfg = readJson('dsh-pet/pet/atri-config.json', errors) || {};
  const pkg = readJson('profiles/desktop/package.json', errors) || {};
  const nudgeRaw = readJson('daily-nudge.json', errors) || {};
  const speakCfg = readJson('speak-up-config.json', errors) || {};
  const fishCfg = readJson('fish-memory-config.json', errors) || {};

  const slots = Object.entries(moodRaw.moods || {}).map(([id, v]) => ({
    id,
    mood: round(v.mood, 2),
    confidence: v.lastConfidence ?? null,
    updatedAt: iso(v.updatedAt),
    lastDecayAt: iso(v.lastDecayAt),
    saidCount: Array.isArray(v.saidAt) ? v.saidAt.length : 0,
    dims: v.dims || {},
    timeline: (Array.isArray(v.timeline) ? v.timeline : []).map((t) => ({
      at: t.at, mood: round(t.mood, 2), delta: t.delta ?? 0,
      conf: t.conf ?? null, reason: t.reason || '',
    })),
  }));
  const activeId = moodRaw.lastActive || '__default__';
  const active = slots.find((s) => s.id === activeId) || slots[0] || null;

  let memDir = [];
  try { memDir = fs.readdirSync(at('fish-memory')).filter((f) => f.endsWith('.json')); }
  catch (e) { errors.push('fish-memory : ' + e.message); }
  const sessions = [];
  let totalMemories = 0, totalTraces = 0, totalBytes = 0, newestMemoryAt = null, newestTraceAt = null;
  for (const file of memDir) {
    const rel = 'fish-memory/' + file;
    const st = fileStat(rel);
    totalBytes += st.bytes;
    let memories = 0, traces = 0, policy = null, latest = null;
    const obj = readJson(rel, errors);
    if (obj) {
      memories = Array.isArray(obj.memories) ? obj.memories.length : 0;
      traces = Array.isArray(obj.traces) ? obj.traces.length : 0;
      policy = obj.policy || null;
      totalMemories += memories;
      totalTraces += traces;
      for (const m of (obj.memories || [])) if (m && m.createdAt && (!latest || m.createdAt > latest)) latest = m.createdAt;
      for (const t of (obj.traces || [])) {
        if (t && typeof t.at === 'number') {
          const s = new Date(t.at).toISOString();
          if (!newestTraceAt || s > newestTraceAt) newestTraceAt = s;
        }
      }
    }
    if (latest && (!newestMemoryAt || latest > newestMemoryAt)) newestMemoryAt = latest;
    sessions.push({ file, bytes: st.bytes, mtime: st.mtime, ageMin: st.ageMin, memories, traces, latestMemoryAt: latest, policy });
  }
  sessions.sort((a, b) => (b.mtime || '').localeCompare(a.mtime || ''));

  const nudges = Object.entries(nudgeRaw).map(([k, v]) => {
    const i = k.indexOf(':');
    return { date: i > 0 ? k.slice(0, i) : k, type: i > 0 ? k.slice(i + 1) : '', at: v };
  }).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const nudgeDays = {};
  for (const n of nudges) nudgeDays[n.date] = (nudgeDays[n.date] || 0) + 1;

  const bundles = (pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles)) ? pkg.dsh.profile.bundles : [];
  const deps = pkg.dependencies || {};
  const plugins = bundles.map((name) => ({ name, version: deps[name] || '内置 / 本地' }));

  const files = WATCHED.map(([label, rel]) => ({ label, rel, ...fileStat(rel) }));
  const fresh = files.filter((f) => f.ageMin !== null && f.ageMin <= 5).length;

  const logs = {};
  for (const [key, rel] of [
    ['fish', 'fish-memory-diag.log'],
    ['mood', 'feiyu-mood/diag.log'],
    ['pet', 'dsh-pet/logs.txt'],
  ]) { const t = tail(rel, 16000, 18); logs[key] = { ...t, ...fileStat(rel) }; }

  const petMain = (petCfg.pets || [])[0] || {};
  const petAtri = (atriCfg.pets || [])[0] || {};
  const origPet = petMain.name || '大肥鱼';
  const origChar = petAtri.name || '亚托莉 ATRI';
  const origOwner = moodCfg.ownerName || '';
  const P = loadPersona();
  const pc = activeCard(P);
  const useName = !!(pc && P.apply.name && pc.name);
  const useOwner = !!(pc && P.apply.owner && pc.ownerName);

  return {
    generatedAt: new Date().toISOString(),
    root: ROOT,
    readOnly: true,
    identity: {
      petName: SETTINGS.petName || origPet,
      character: useName ? pc.name : (SETTINGS.characterName || origChar),
      owner: useOwner ? pc.ownerName : (SETTINGS.ownerName || origOwner),
      originalPetName: origPet,
      originalCharacter: origChar,
      originalOwner: origOwner,
      customized: !!(SETTINGS.petName || SETTINGS.characterName || SETTINGS.ownerName || useName || useOwner),
      persona: pc ? {
        id: pc.id, name: pc.name, filename: pc.filename, format: pc.format, spec: pc.spec,
        description: pc.description, personality: pc.personality, scenario: pc.scenario,
        firstMes: pc.firstMes, mesExample: pc.mesExample, systemPrompt: pc.systemPrompt,
        creatorNotes: pc.creatorNotes, ownerName: pc.ownerName, tags: pc.tags, apply: P.apply,
      } : null,
      selfAliases: moodCfg.selfAliases || '',
      workspace: (moodCfg.slots || [])[0] && (moodCfg.slots[0].label || ''),
      activeSlot: activeId,
      petDisplay: petAtri.display || petMain.display || '',
      whisperPrompt: atriCfg.whisperPrompt || '',
    },
    mood: {
      value: active ? active.mood : null,
      base: moodCfg.moodBase ?? 70,
      floor: moodCfg.moodFloor ?? 0,
      decayHalfHours: moodCfg.decayHalfHours ?? null,
      autoJudge: moodCfg.autoJudge ?? null,
      injectPerDay: moodCfg.injectPerDay ?? null,
      confidence: active ? active.confidence : null,
      updatedAt: active ? active.updatedAt : null,
      lastDecayAt: active ? active.lastDecayAt : null,
      dims: active ? active.dims : {},
      saidCount: active ? active.saidCount : 0,
      timeline: active ? active.timeline : [],
      slots: slots.map(({ timeline, dims, ...rest }) => rest),
    },
    memory: {
      sessionCount: sessions.length,
      totalBytes, totalMemories, totalTraces, newestMemoryAt, newestTraceAt,
      sessions, config: fishCfg,
    },
    activity: { files, freshCount: fresh, nudges: nudges.slice(0, 60), nudgeDays, speakUp: speakCfg },
    logs,
    plugins,
    process: processes(),
    errors,
  };
}

let cache = { at: 0, value: null };

/* DSH 联动桥（dsh-qianfeiwanyu）推来的 Agent 状态，仅内存保存，不落盘、不联网 */
const AGENT_STATES = ['idle', 'working', 'think', 'wait', 'celebrate', 'error', 'welcome'];
let DSH_AGENT_STATE = { state: 'idle', detail: '', speak: true, at: 0, from: '' };
function setDshAgentState(body) {
  const s = String(body && body.state || '').toLowerCase();
  if (AGENT_STATES.indexOf(s) < 0) return { ok: false, error: 'unknown state' };
  if (body && body.app && String(body.app) !== 'qianfeiwanyu-bridge') {
    /* 允许任意本机来源，但记录来源便于排查；不强制校验，避免版本差异导致联动失效 */
  }
  DSH_AGENT_STATE = {
    state: s,
    detail: String(body && body.detail || '').slice(0, 300),
    speak: body && body.speak === false ? false : true,
    at: Number(body && body.at) || Date.now(),
    from: String(body && body.app || ''),
  };
  return { ok: true, state: DSH_AGENT_STATE };
}

function snapshot() {
  if (cache.value && Date.now() - cache.at < CACHE_MS) return cache.value;
  const value = buildSnapshot();
  cache = { at: Date.now(), value };
  return value;
}

/* ---------- 素材（本程序目录） ---------- */

const MEDIA = {
  'atri': ['dsh-pet/pet/atri-avatar.png', 'image/png'],
  'anna': ['dsh-pet/pet/anna-avatar.png', 'image/png'],
  'atri-idle': ['dsh-pet/pet/atri-animation/idle.webm', 'video/webm'],
  'atri-sit': ['dsh-pet/pet/atri-animation/sit.webm', 'video/webm'],
  'atri-relax': ['dsh-pet/pet/atri-animation/relax.webm', 'video/webm'],
  'atri-jump': ['dsh-pet/pet/atri-animation/jump.webm', 'video/webm'],
  'atri-walk': ['dsh-pet/pet/atri-animation/walk.webm', 'video/webm'],
  'anna-idle': ['dsh-pet/pet/anna-animation/待机呼吸.webm', 'video/webm'],
  'anna-think': ['dsh-pet/pet/anna-animation/思考.webm', 'video/webm'],
  'anna-wave': ['dsh-pet/pet/anna-animation/挥手.webm', 'video/webm'],
};

function serveMedia(req, res, key) {
  const entry = MEDIA[key];
  if (!entry) { res.writeHead(404); res.end('unknown media'); return; }
  const p = at(entry[0]);
  let st;
  try { st = fs.statSync(p); } catch (e) { res.writeHead(404); res.end('missing'); return; }
  const type = entry[1];
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m && m[1] ? Number(m[1]) : 0;
    let end = m && m[2] ? Number(m[2]) : st.size - 1;
    if (start >= st.size) { res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); res.end(); return; }
    end = Math.min(end, st.size - 1);
    res.writeHead(206, {
      'Content-Type': type, 'Content-Range': 'bytes ' + start + '-' + end + '/' + st.size,
      'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
    });
    fs.createReadStream(p, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, {
    'Content-Type': type, 'Content-Length': st.size,
    'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
  });
  fs.createReadStream(p).pipe(res);
}

const EMPTY_ASSETS = {
  background: { day: '', dusk: '', night: '' },
  portrait: { idle: '', happy: '', sad: '', avatar: '' },
  portrait2: { idle: '' },
  ui: { dialog: '', nameplate: '' },
  audio: { bgm: '' },
};
function loadAssets() {
  let a = {};
  try { a = JSON.parse(fs.readFileSync(localPath('assets.json'), 'utf8')); }
  catch (e) { a = {}; }
  const out = {
    background: Object.assign({}, EMPTY_ASSETS.background, a.background),
    portrait: Object.assign({}, EMPTY_ASSETS.portrait, a.portrait),
    portrait2: Object.assign({}, EMPTY_ASSETS.portrait2, a.portrait2),
    ui: Object.assign({}, EMPTY_ASSETS.ui, a.ui),
    audio: Object.assign({}, EMPTY_ASSETS.audio, a.audio),
    useDshPetArt: !!a.useDshPetArt,
    atriExpr: (a.atriExpr && typeof a.atriExpr === 'object') ? a.atriExpr : null,
    // 角色形态：whale-mature（默认成熟鲸鱼娘）/ whale-chibi（Q版鲸鱼娘）
    form: ['whale-mature', 'whale-chibi'].indexOf(a.form) >= 0 ? a.form : 'whale-mature',
    // 鲸鱼娘形态下是否沿用亚托莉场景库背景：默认否（用鲸鱼娘场景/壁纸）
    whaleBgFromAtri: !!a.whaleBgFromAtri,
    // 鲸鱼娘横版壁纸钉住项（C70..C77 的编号），空表示按时段用氛围场景
    whaleWallpaper: /^C_壁纸0[1-4]$/.test(String(a.whaleWallpaper || '')) ? String(a.whaleWallpaper) : '',
  };
  // 槽位分配以 assets.json 为唯一真源；settings.portrait 仅作为旧接口的兼容字段保留。
  return out;
}
/* ---------- 场景库：场景 × 时段 × 季节（scenes.json 由本程序生成，只读） ---------- */

const SCENES_FILE = localPath('scenes.json');
const SEASON_KEYS = ['spring', 'summer', 'autumn', 'winter'];
const SLOT_KEYS = ['day', 'dusk', 'night'];
let sceneCache = { at: 0, value: null };
function sceneFile(v) {
  return /^bg\/[A-Za-z0-9._-]+$/.test(String(v || '')) ? String(v) : '';
}
function loadSceneLibrary() {
  let st;
  try { st = fs.statSync(SCENES_FILE); } catch (e) { return { version: 1, seasons: SEASON_KEYS, list: [] }; }
  if (sceneCache.value && sceneCache.at === st.mtimeMs) return sceneCache.value;
  let lib = { version: 1, seasons: SEASON_KEYS, list: [] };
  try {
    const j = JSON.parse(fs.readFileSync(SCENES_FILE, 'utf8'));
    if (j && Array.isArray(j.list)) {
      lib = {
        version: j.version || 1,
        seasons: SEASON_KEYS,
        list: j.list.filter((s) => s && /^[A-Za-z0-9._-]{1,40}$/.test(String(s.id || ''))).map((s) => ({
          id: String(s.id),
          label: String(s.label || s.id).slice(0, 40),
          desc: String(s.desc || '').slice(0, 140),
          seasons: Array.isArray(s.seasons) && s.seasons.length
            ? s.seasons.filter((k) => SEASON_KEYS.indexOf(k) >= 0)
            : SEASON_KEYS.slice(),
          slots: {
            day: sceneFile(s.slots && s.slots.day),
            dusk: sceneFile(s.slots && s.slots.dusk),
            night: sceneFile(s.slots && s.slots.night),
          },
        })),
      };
    }
  } catch (e) { /* 目录损坏时退回空库，不影响其它接口 */ }
  sceneCache = { at: st.mtimeMs, value: lib };
  return lib;
}
function sceneState(lib) {
  const raw = loadAssetsRaw();
  const sc = raw.scenes && typeof raw.scenes === 'object' && !Array.isArray(raw.scenes) ? raw.scenes : {};
  const ids = ['auto', 'custom'].concat(lib.list.map((s) => s.id));
  return {
    pin: ids.indexOf(sc.pin) >= 0 ? sc.pin : 'auto',
    season: SEASON_KEYS.indexOf(sc.season) >= 0 ? sc.season : 'auto',
    slot: SLOT_KEYS.indexOf(sc.slot) >= 0 ? sc.slot : 'auto',
  };
}

function setSceneState(body) {
  const lib = loadSceneLibrary();
  const cur = sceneState(lib);
  const next = { pin: cur.pin, season: cur.season, slot: cur.slot };
  if (body.pin !== undefined) {
    const pin = String(body.pin);
    if (['auto', 'custom'].concat(lib.list.map((s) => s.id)).indexOf(pin) < 0) {
      throw httpError(400, '未知的场景：' + pin.slice(0, 60));
    }
    next.pin = pin;
  }
  if (body.season !== undefined) {
    const season = String(body.season);
    if (season !== 'auto' && SEASON_KEYS.indexOf(season) < 0) {
      throw httpError(400, '未知的季节：' + season.slice(0, 20));
    }
    next.season = season;
  }
  if (body.slot !== undefined) {
    const slot = String(body.slot);
    if (slot !== 'auto' && SLOT_KEYS.indexOf(slot) < 0) {
      throw httpError(400, '未知的时段：' + slot.slice(0, 20));
    }
    next.slot = slot;
  }
  const raw = loadAssetsRaw();
  raw.scenes = next;
  saveAssetsRaw(raw);
  return { ok: true, scenes: next, library: lib };
}
function assetsPayload() {
  const lib = loadSceneLibrary();
  return { config: loadAssets(), files: listAssets(), scenes: { state: sceneState(lib), list: lib.list, seasons: lib.seasons } };
}

/* ---------- 素材包导入导出：零依赖 ZIP(store) 读写 ----------
 * 图片/音频本身已压缩，ZIP 用 store（不二次压缩）即可，速度快、内存省。
 * 包内结构：
 *   manifest.json                      清单（格式/版本/文件表 sha 校验/导出范围）
 *   assets.json                        槽位配置（always）
 *   scenes.json                        场景库定义（always）
 *   assets/audio/index.json            音频清单（always）
 *   assets/uploads/*                   上传素材（always）
 *   assets/bg/*  assets/ui/*           内置背景/UI（仅 full 范围）
 *   assets/audio/bgm|amb|sfx/*         音频文件（仅 full 范围）
 * 导入的安全边界：仅写 manifest 列出的相对路径，逐个经 localPath() 前缀校验，
 * 拒绝 .. / 绝对路径 / 非白名单扩展名；导入前把现有配置备份到 data/assetpack-backups/。
 */
const PACK_FORMAT = 'fishwatch-assetpack';
const PACK_VERSION = 1;
const PACK_CONFIG_FILES = ['assets.json', 'scenes.json', 'assets/audio/index.json'];
const PACK_SAFE = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;   // 相对路径、无 .. 无盘符
const PACK_ALLOWED_EXT = /\.(?:png|jpe?g|webp|gif|ogg|mp3|m4a|wav|webm|json)$/i;
/* 素材包允许写入的路径：仅限明确列出的配置文件，以及 assets/ 下的素材。
 * settings.json / persona.json / *.yml / server.js 等一律拒绝，避免「导入素材」越权覆盖配置。 */
function packWriteAllowed(rel) {
  if (PACK_CONFIG_FILES.indexOf(rel) >= 0) return true;
  return rel.indexOf('assets/') === 0;
}

/* CRC32（标准 IEEE 多项式，查表法） */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function dosTime(d) {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time: time & 0xFFFF, date: date & 0xFFFF };
}
/* 打包：entries = [{ name(相对路径), data(Buffer) }]，store 模式 */
function zipStore(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  const t = dosTime(new Date());
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = e.data, size = data.length, crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(t.time, 10); lh.writeUInt16LE(t.date, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(size, 18); lh.writeUInt32LE(size, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(t.time, 12); ch.writeUInt16LE(t.date, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(size, 20); ch.writeUInt32LE(size, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += lh.length + name.length + size;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([Buffer.concat(locals), cd, eocd]);
}
/* 解包：仅接受 store 模式，返回 [{ name, data }]；校验 CRC */
function unzipStore(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw httpError(400, '素材包不是有效的 ZIP 文件');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw httpError(400, '找不到 ZIP 结束记录');
  const count = buf.readUInt16LE(eocd + 10);
  if (!count || count > 20000) throw httpError(400, 'ZIP 条目数量异常');
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw httpError(400, 'ZIP 中央目录损坏');
    const method = buf.readUInt16LE(p + 10);
    if (method !== 0) throw httpError(400, '素材包含不支持的压缩方式（仅 store）');
    const crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== 0x04034b50) throw httpError(400, 'ZIP 本地头损坏：' + name);
    const lnLen = buf.readUInt16LE(lho + 26), lxLen = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lnLen + lxLen;
    if (start + csize > buf.length) throw httpError(400, 'ZIP 数据越界：' + name);
    const data = buf.slice(start, start + csize);
    if (crc32(data) !== crc) throw httpError(400, '素材包校验失败（CRC 不符）：' + name);
    out.push({ name, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
/* 收集要打包的文件；scope=mine 只带上传素材，full 带全部图片/音频/UI */
function collectPackFiles(scope) {
  const out = [];
  const push = (rel, file) => {
    try {
      const p = localPath(rel);
      if (!fs.statSync(p).isFile()) return;
      out.push({ name: rel, data: fs.readFileSync(p) });
    } catch (e) { /* 文件不存在则跳过 */ }
  };
  for (const c of PACK_CONFIG_FILES) push(c);
  const dirs = scope === 'full'
    ? ['assets/uploads', 'assets/bg', 'assets/ui', 'assets/audio']
    : ['assets/uploads'];
  const addFile = (rel, full) => {
    if (!PACK_SAFE.test(rel) || !PACK_ALLOWED_EXT.test(rel)) return;
    try { if (fs.statSync(full).isFile()) out.push({ name: rel, data: fs.readFileSync(full) }); }
    catch (e) { /* skip */ }
  };
  for (const d of dirs) {
    const abs = localPath(d);
    let names = [];
    try { names = fs.readdirSync(abs); } catch (e) { continue; }
    for (const n of names) {
      const rel = d + '/' + n;
      const full = path.join(abs, n);
      let st;
      try { st = fs.statSync(full); } catch (e) { continue; }
      // audio 目录下有两级（bgm/amb/sfx），目录名本身不带扩展名，先展开再逐个校验文件
      if (d === 'assets/audio' && st.isDirectory() && ['bgm', 'amb', 'sfx'].indexOf(n) >= 0) {
        let subs = [];
        try { subs = fs.readdirSync(full); } catch (e) { continue; }
        for (const sn of subs) addFile(rel + '/' + sn, path.join(full, sn));
      } else {
        addFile(rel, full);
      }
    }
  }
  return out;
}
function buildAssetPack(scope) {
  const files = collectPackFiles(scope);
  const manifest = {
    format: PACK_FORMAT, version: PACK_VERSION, scope: scope === 'full' ? 'full' : 'mine',
    exportedAt: new Date().toISOString(), app: 'fish-watch',
    note: '千肥万鱼素材包。导入会按清单还原文件，导入前自动备份现有配置。',
    files: files.map((f) => ({ path: f.name, size: f.data.length, crc: crc32(f.data) })),
  };
  const entries = [{ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') }].concat(files);
  return { buf: zipStore(entries), count: files.length, manifest };
}
/* 导入：校验 manifest 与逐文件 CRC，路径安全后写回，返回统计。
 * 资源上限：素材包是 store 模式（不压缩），所以「解压后体积 = 上传体积」，不存在 ZIP 炸弹；
 * 这里再按文件数 / 单文件 / 累计上传量兜一层，防止被反复当写盘放大器用。 */
const PACK_MAX_FILES = 3000;
const PACK_MAX_FILE_BYTES = 32 * 1024 * 1024;
const PACK_WINDOW = { at: 0, bytes: 0, windowMs: 10 * 60 * 1000, maxBytes: 256 * 1024 * 1024 };

function packBudget(bytes) {
  const now = Date.now();
  if (now - PACK_WINDOW.at > PACK_WINDOW.windowMs) { PACK_WINDOW.at = now; PACK_WINDOW.bytes = 0; }
  if (PACK_WINDOW.bytes + bytes > PACK_WINDOW.maxBytes) {
    throw httpError(429, '素材包导入过于频繁（10 分钟内累计超过 256 MB），请稍后再试');
  }
  PACK_WINDOW.bytes += bytes;
}
function ensureDiskSpace(needBytes) {
  let free = -1;
  try {
    const st = fs.statfsSync(APP_DIR);
    free = Number(st.bavail) * Number(st.bsize);
  } catch (e) { return; }   /* 拿不到就不拦，别把正常导入卡死 */
  const reserve = 200 * 1024 * 1024;
  if (free >= 0 && free < needBytes + reserve) {
    throw httpError(507, '磁盘剩余空间不足：还需要约 ' + Math.ceil((needBytes + reserve) / 1048576) + ' MB，请先清理再导入。');
  }
}
function importAssetPack(buf) {
  packBudget(buf.length);
  const entries = unzipStore(buf);
  if (entries.length > PACK_MAX_FILES) throw httpError(413, '素材包文件数超过上限（' + PACK_MAX_FILES + ' 个）');
  for (const e of entries) {
    if (e.data.length > PACK_MAX_FILE_BYTES) throw httpError(413, '素材包里单个文件超过 32 MB：' + e.name.slice(0, 80));
  }
  const man = entries.find((e) => e.name === 'manifest.json');
  if (!man) throw httpError(400, '素材包缺少 manifest.json，不是千肥万鱼素材包');
  let mf;
  try { mf = JSON.parse(man.data.toString('utf8')); }
  catch (e) { throw httpError(400, 'manifest.json 不是合法 JSON'); }
  if (mf.format !== PACK_FORMAT || mf.version !== PACK_VERSION) {
    throw httpError(400, '素材包格式或版本不兼容（需要 ' + PACK_FORMAT + ' v' + PACK_VERSION + '）');
  }
  const table = {};
  for (const f of (Array.isArray(mf.files) ? mf.files : [])) table[f.path] = f;
  const writes = [];
  for (const e of entries) {
    if (e.name === 'manifest.json') continue;
    if (!PACK_SAFE.test(e.name) || e.name.split('/').some((s) => s === '..' || s === '.' || !s)) {
      throw httpError(400, '素材包含非法路径：' + e.name.slice(0, 80));
    }
    if (!PACK_ALLOWED_EXT.test(e.name)) throw httpError(400, '素材包含不允许的文件类型：' + e.name.slice(0, 80));
    if (!packWriteAllowed(e.name)) throw httpError(400, '素材包含不允许写入的文件：' + e.name.slice(0, 80));
    const meta = table[e.name];
    if (!meta) throw httpError(400, '清单里没有登记的文件：' + e.name.slice(0, 80));
    if (meta.size !== e.data.length || meta.crc !== crc32(e.data)) {
      throw httpError(400, '文件内容与清单不符：' + e.name.slice(0, 80));
    }
    writes.push({ name: e.name, data: e.data });
  }
  /* 导入前备份现有配置文件，便于回滚 */
  const totalBytes = writes.reduce((n, w) => n + w.data.length, 0);
  ensureDiskSpace(totalBytes * 2);   /* 备份一份 + 写入一份 */
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const backupDir = localPath('data/assetpack-backups/' + stamp);
  fs.mkdirSync(backupDir, { recursive: true });
  for (const c of PACK_CONFIG_FILES) {
    try {
      const src = localPath(c);
      if (fs.statSync(src).isFile()) fs.writeFileSync(path.join(backupDir, path.basename(c)), fs.readFileSync(src));
    } catch (e) { /* 缺文件不备份 */ }
  }
  /* 写回 */
  let bytes = 0;
  for (const w of writes) {
    const p = localPath(w.name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, w.data);
    bytes += w.data.length;
  }
  cache = { at: 0, value: null };
  return { ok: true, files: writes.length, bytes, scope: mf.scope, backup: 'data/assetpack-backups/' + stamp, assets: assetsPayload() };
}

/* ---------- 每日日程：千肥万鱼自包含 + 兼容 DSH daily-schedule ----------
 * 自有日程：fish-watch/data/schedules/YYYY-MM-DD.json（可生成、可编辑、可保存）
 * 兼容来源：<DSH_HOME>/daily-schedule/days/YYYY-MM-DD.json（只读，不写回 DSH）
 * 把「此刻在做什么」映射成场景 id / 时段 / 立绘心情，交给前端切背景与立绘。 */
const DSH_HOME = ROOT;   /* 统一走 ROOT（DSH_ROOT → ~/.dsh），避免两套路径解析不一致 */
const DSH_DAYS_DIR = path.join(DSH_HOME, 'daily-schedule', 'days');
const FISH_DAYS_DIR = localPath('data/schedules');
let scheduleCache = { key: '', at: 0, value: null };

function dayKey(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function fishDayFile(key) { return path.join(FISH_DAYS_DIR, validDayKey(key) ? key + '.json' : 'invalid.json'); }
function dshDayFile(key) { return path.join(DSH_DAYS_DIR, validDayKey(key) ? key + '.json' : 'invalid.json'); }
function hhmmMin(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
  if (!m) return -1;
  const h = +m[1], mi = +m[2];
  return h > 24 || mi > 59 ? -1 : h * 60 + mi;
}
function normText(v, max) {
  if (v == null) return '';
  return String(v).replace(/[\r\n\t]+/g, ' ').slice(0, max || 240);
}
function normalizeDay(raw, key, source, opts) {
  const j = raw && typeof raw === 'object' ? raw : {};
  const o = opts || {};
  let dayType = '';
  if (typeof j.dayType === 'string') dayType = j.dayType;
  else if (j.dayType && typeof j.dayType === 'object') dayType = j.dayType.name || j.dayType.label || '';
  const items = (Array.isArray(j.items) ? j.items : []).slice(0, 64).map((it) => ({
    start: normText(it.start, 5), end: normText(it.end, 5),
    activity: normText(it.activity, 120), location: normText(it.location, 120),
    detail: normText(it.detail, 320), situation: normText(it.situation, 160),
  })).filter((it) => hhmmMin(it.start) >= 0);
  items.sort((a, b) => hhmmMin(a.start) - hhmmMin(b.start));
  return {
    date: validDayKey(j.date) ? j.date : key,
    dayType: normText(dayType, 80),
    title: normText(j.title, 160),
    mood: normText(j.mood, 80),
    hint: normText(j.hint, 500),
    source: source,
    generated: !!(o.generated || j.generated),
    persisted: !!(o.persisted || j.persisted),
    updatedAt: normText(j.updatedAt, 40),
    items: items,
  };
}
function loadDayFile(file, source) {
  let st;
  try { st = fs.statSync(file); } catch (e) { return null; }
  if (!st.isFile()) return null;
  const cacheKey = source + '|' + file + '|' + st.mtimeMs;
  if (scheduleCache.value && scheduleCache.key === cacheKey) return scheduleCache.value;
  let j;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
  if (!j || !Array.isArray(j.items)) return null;
  const key = path.basename(file, '.json');
  const v = normalizeDay(j, key, source, { persisted: source === 'fishwatch' });
  scheduleCache = { key: cacheKey, at: st.mtimeMs, value: v };
  return v;
}
function loadFishDay(key) {
  if (!validDayKey(key)) return null;
  return loadDayFile(fishDayFile(key), 'fishwatch');
}
function loadDshDay(key) {
  if (!validDayKey(key)) return null;
  return loadDayFile(dshDayFile(key), 'dsh');
}
function clearScheduleCache() { scheduleCache = { key: '', at: 0, value: null }; }

/* 本地日程生成：零依赖、按日期稳定，不联网、不调用 DSH，也不写 DSH 目录。 */
function seededRand(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  h = h >>> 0;
  return function () {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    return h / 4294967296;
  };
}
function pick(rnd, list) { return list[Math.floor(rnd() * list.length) % list.length]; }
function generateDay(key) {
  if (!validDayKey(key)) throw httpError(400, '日期格式应为 YYYY-MM-DD');
  const rnd = seededRand(key);
  const d = new Date(key + 'T12:00:00');
  const weekday = d.getDay();
  const weekend = weekday === 0 || weekday === 6;
  const weekBlocks = [
    ['00:00', '06:30', '睡觉', '自宅卧室', '安心', '安安静静睡得很沉'],
    ['06:30', '07:10', '起床洗漱', '自宅', '清醒', '揉揉眼睛，把头发梳好'],
    ['07:10', '08:00', '吃早饭', '自宅餐桌', '满足', '热腾腾的早饭，吃得很满足'],
    ['08:00', '08:45', '通勤去学校', '上学路', '轻快', '沿着上学路慢慢走向学校'],
    ['08:45', '11:30', '上课与记笔记', '教室', '认真', '在教室里学习新知识'],
    ['11:30', '12:30', '午休吃饭', '餐厅', '开心', '好吃的便当，坐在餐厅里晒太阳'],
    ['12:30', '15:30', '写代码与整理资料', '学校工位', '专注', '调试程序，顺便赶进度'],
    ['15:30', '16:30', '学习日语', '教室', '认真', '练发音，记新单词'],
    ['16:30', '17:30', '街道散步', '街道', '放松', '沿街走走，看看路边的小店'],
    ['17:30', '18:15', '便利店买饭团', '街道便利店', '轻快', '顺路外带一个饭团'],
    ['18:15', '19:30', '回家做晚饭', '自宅厨房', '满足', '做晚饭，闻起来很香'],
    ['19:30', '21:00', '看综艺放松', '自宅客厅', '开心', '窝在沙发上看综艺，笑得很开心'],
    ['21:00', '22:00', '整理与睡前聊天', '自宅客厅', '平静', '整理今天的小事，顺便聊聊天'],
    ['22:00', '24:00', '睡觉', '自宅卧室', '安心', '钻进被窝，准备睡个懒觉'],
  ];
  const restBlocks = [
    ['00:00', '08:00', '睡觉', '自宅卧室', '安心', '难得睡个懒觉，睡得很香'],
    ['08:00', '09:00', '吃早饭', '自宅餐桌', '满足', '慢悠悠地吃早饭，很满足'],
    ['09:00', '11:00', '打扫房间', '自宅客厅', '平静', '整理桌面和沙发，把房间收拾干净'],
    ['11:00', '12:00', '走廊溜达', '学校走廊', '放松', '沿窗慢慢走，看看校园'],
    ['12:00', '13:00', '吃螃蟹汉堡', '餐厅', '开心', '好吃的螃蟹汉堡，太治愈了'],
    ['13:00', '15:00', '读书', '自宅客厅', '平静', '翻几页喜欢的书'],
    ['15:00', '17:00', '街道闲逛', '街道二', '开心', '逛逛街，看到有趣的小东西'],
    ['17:00', '18:00', '山路散步', '山路', '放松', '沿着山路走走，看看树影'],
    ['18:00', '19:00', '回家做晚饭', '自宅厨房', '满足', '给自己做一顿热乎晚饭'],
    ['19:00', '21:00', '打游戏追剧', '自宅客厅', '开心', '窝在沙发上打游戏，笑得很开心'],
    ['21:00', '22:00', '泡澡', '澡堂', '平静', '泡个热水澡，把疲惫冲掉'],
    ['22:00', '24:00', '睡觉', '自宅卧室', '安心', '钻进被窝，准备睡个懒觉'],
  ];
  const blocks = weekend ? restBlocks : weekBlocks;
  const seasonNote = pick(rnd, ['今天也按部就班。', '把小事一件件做好。', '阳光落在窗台上。', '日子慢慢过就好。']);
  const items = blocks.map((b) => ({
    start: b[0], end: b[1], activity: b[2], location: b[3],
    situation: b[4], detail: b[5] + ' ' + seasonNote,
  }));
  return normalizeDay({
    date: key,
    dayType: { name: weekend ? '休息日' : '平日' },
    title: pick(rnd, weekend ? ['慢慢来的一天', '舒服的休息日', '不赶时间'] : ['按部就班的一天', '普通但认真的一天', '学习与日常']),
    mood: pick(rnd, ['平静', '认真', '还不错']),
    hint: '千肥万鱼本地生成的日程，不依赖 dsh-daily-schedule。',
    generated: true,
    persisted: false,
    items: items,
  }, key, 'fishwatch');
}
function persistDay(day) {
  const key = day.date;
  const file = fishDayFile(key);
  const out = normalizeDay(day, key, 'fishwatch', { persisted: true });
  out.updatedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n', 'utf8');
  clearScheduleCache();
  return loadFishDay(key) || out;
}
function saveDayInput(key, raw) {
  if (!validDayKey(key)) throw httpError(400, '日期格式应为 YYYY-MM-DD');
  const body = raw && typeof raw === 'object' ? raw : {};
  const j = body.day && typeof body.day === 'object' ? body.day : body;
  const day = normalizeDay(j, key, 'fishwatch', { persisted: true });
  if (!day.items.length) throw httpError(400, '日程至少需要一个有效条目（HH:MM）');
  day.updatedAt = new Date().toISOString();
  fs.writeFileSync(fishDayFile(key), JSON.stringify(day, null, 2) + '\n', 'utf8');
  clearScheduleCache();
  return loadFishDay(key) || day;
}
function clearFishDay(key) {
  if (!validDayKey(key)) throw httpError(400, '日期格式应为 YYYY-MM-DD');
  let removed = false;
  try { fs.unlinkSync(fishDayFile(key)); removed = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  clearScheduleCache();
  return removed;
}

function slotFromMin(min) {
  if (min >= 9 * 60 && min < 17 * 60) return 'day';
  if (min >= 17 * 60 && min < 21 * 60) return 'dusk';
  return 'night';
}
/* 关键词 → 场景 id。按顺序取第一个命中；场景必须在 scenes.json 里存在。 */
const SCHEDULE_SCENE_RULES = [
  { id: 'school', kw: ['写代码', '工作', '公司', '工位', '办公桌', '会议', '加班', '赶进度', '堆积任务', '任务', '资料', '调试', 'bug', '方案', '茶水间', '准备开工', '收尾', '上课', '学校', '校舍'] },
  { id: 'street', kw: ['通勤', '地铁', '电车', '上班', '下班', '外出', '车站', '路上', '便利店', '买饭团', '超市', '外带', '逛街', '商店街'] },
  { id: 'home', kw: ['家里', '自宅', '卧室', '客厅', '厨房', '餐桌', '浴室', '睡觉', '上床', '起床', '早饭', '晚饭', '做晚饭', '电视', '综艺', '放松', '休息', '洗澡', '整理', '打扫', '睡前', '睡个懒觉', '外卖', '打游戏', '追剧'] },
  { id: 'schoolroad', kw: ['上学路', '散步', '公园', '坡道'] },
  { id: 'classroom', kw: ['教室', '读书', '学习'] },
  { id: 'hospital', kw: ['医院', '看病', '复诊'] },
  { id: 'shrine', kw: ['神社', '许愿', '风铃'] },
  { id: 'bathhouse', kw: ['澡堂', '泡澡', '浴场'] },
  { id: 'restaurant', kw: ['餐厅', '咖啡', '饭店', '螃蟹', '汉堡', '吃', '吃饭'] },
  { id: 'mountain', kw: ['山里', '山间', '树林', '爬山'] },
  { id: 'street2', kw: ['街道二', '第二条街'] },
  { id: 'street3', kw: ['街道三', '小巷'] },
  { id: 'inn', kw: ['旅馆', '客栈', '住宿'] },
];
const SCHEDULE_HAPPY = ['好吃', '螃蟹', '汉堡', '满足', '高兴', '开心', '笑', '治愈', '搞定', '完成', '终于', '转圈', '舒服', '得意', '高性能'];
const SCHEDULE_SAD = ['累', '困', '挤', '烦', '难过', '疲惫', '犯困', '赶进度', '差点被', '煎得有点焦'];
function mapSchedule(item, nowMin, lib) {
  const text = [item.activity, item.location, item.detail, item.situation].join(' ');
  let sceneId = '', sceneReason = '';
  for (let i = 0; i < SCHEDULE_SCENE_RULES.length; i++) {
    const r = SCHEDULE_SCENE_RULES[i];
    const hit = r.kw.some((k) => text.indexOf(k) >= 0);
    if (!hit) continue;
    if (lib.list.some((s) => s.id === r.id)) { sceneId = r.id; sceneReason = r.kw.filter((k) => text.indexOf(k) >= 0)[0]; }
    break;
  }
  let mood = 'idle', moodReason = '';
  const sleep = /睡觉|上床|睡前|睡懒觉|起床洗漱/.test(item.activity);
  const happy = SCHEDULE_HAPPY.filter((k) => text.indexOf(k) >= 0)[0];
  const sad = SCHEDULE_SAD.filter((k) => text.indexOf(k) >= 0)[0];
  /* 睡眠时段优先平静，避免 detail 里的「昨天玩得很开心」把她切成 happy */
  if (sleep) { mood = 'idle'; moodReason = item.activity; }
  else if (happy) { mood = 'happy'; moodReason = happy; }
  else if (sad) { mood = 'sad'; moodReason = sad; }
  return { sceneId: sceneId, sceneReason: sceneReason, slot: slotFromMin(nowMin), mood: mood, moodReason: moodReason };
}
function resolveDay(now, cfg) {
  const key = dayKey(now);
  const prevKey = dayKey(new Date(now.getTime() - 86400000));
  const source = cfg.source;
  const useFish = source === 'auto' || source === 'fishwatch' || source === 'manual';
  const useDsh = source === 'auto' || source === 'dsh';
  const chain = [];
  if (source === 'auto') chain.push([key, 'fish'], [key, 'dsh'], [prevKey, 'fish'], [prevKey, 'dsh']);
  else if (source === 'fishwatch' || source === 'manual') chain.push([key, 'fish'], [prevKey, 'fish']);
  else chain.push([key, 'dsh'], [prevKey, 'dsh']);
  for (let i = 0; i < chain.length; i++) {
    const d = chain[i][1] === 'fish' ? loadFishDay(chain[i][0]) : loadDshDay(chain[i][0]);
    if (d && d.items.length) return d;
  }
  if (cfg.autoGenerate && (source === 'auto' || source === 'fishwatch')) {
    return persistDay(generateDay(key));
  }
  return null;
}
function scheduleNow() {
  const now = new Date();
  const key = dayKey(now);
  const cfg = (SETTINGS.schedule || DEFAULT_SETTINGS.schedule);
  const day = resolveDay(now, cfg);
  const lib = loadSceneLibrary();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const base = {
    ok: true, available: !!day, date: day ? day.date : key,
    nowMin: nowMin, nowTime: String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0'),
    config: {
      enabled: !!cfg.enabled, driveScene: !!cfg.driveScene, driveSlot: !!cfg.driveSlot, drivePortrait: !!cfg.drivePortrait,
      source: cfg.source, sourceLabel: SCHEDULE_SOURCE_LABEL[cfg.source] || cfg.source,
      autoGenerate: !!cfg.autoGenerate, sources: SCHEDULE_SOURCES.slice(), sourceLabels: SCHEDULE_SOURCE_LABEL,
    },
    source: cfg.source,
    daySource: day ? day.source : '',
    generated: day ? !!day.generated : false,
    persisted: day ? !!day.persisted : false,
    day: day || null,
    dayType: '', title: '', mood: '', items: [], current: null, next: null, mapping: null,
  };
  if (!day) {
    if (cfg.source === 'dsh') base.hint = '当前来源是 DSH 日程插件，但没有找到 ' + key + '.json。切到「千肥万鱼自有日程」或「自动」即可自己生成。';
    else if (cfg.source === 'manual') base.hint = '手动来源还没有保存日程。点击下方「生成今日日程」或粘贴 JSON 后保存。';
    else base.hint = '暂无日程。允许自动生成时，千肥万鱼会在本地生成一份，不再需要 dsh-daily-schedule。';
    return base;
  }
  base.dayType = day.dayType; base.title = day.title; base.mood = day.mood; base.items = day.items;
  let idx = -1;
  for (let i = 0; i < day.items.length; i++) {
    const a = hhmmMin(day.items[i].start), b = hhmmMin(day.items[i].end);
    if (a >= 0 && b > a && nowMin >= a && nowMin < b) { idx = i; break; }
  }
  if (idx < 0) {
    /* 空档：取最近的下一段，否则最后一段 */
    for (let i = 0; i < day.items.length; i++) { if (hhmmMin(day.items[i].start) > nowMin) { idx = i; break; } }
    if (idx < 0) idx = day.items.length - 1;
  }
  base.current = day.items[idx] || null;
  base.next = day.items[idx + 1] || null;
  base.mapping = base.current ? mapSchedule(base.current, nowMin, lib) : null;
  return base;
}

// 槽位可指向素材库里实际存在的文件：根目录散图、上传图、以及内置鲸鱼娘/亚托莉目录。
// 注意必须与 listAssets() 能列举的前缀一致，否则内置立绘会被误判为「名称不合法」而设置失败。
const ASSET_NAME = /^(?:(?:uploads|atri|whale)\/)?[\u4e00-\u9fa5A-Za-z0-9._-]+$/;
// 只读 UI 素材允许从 assets/ui/ 提供；场景背景库从 assets/bg/ 提供。两者都不进素材库列表。
const SERVE_NAME = /^(?:(?:uploads|ui|bg|audio|atri|whale)\/)?[\u4e00-\u9fa5A-Za-z0-9._-]+$/;
/* 音频子目录（audio/bgm|amb|sfx）需要两级路径，单独放宽到两级且仅限 audio 白名单 */
const SERVE_AUDIO_NAME = /^audio\/(?:bgm|amb|sfx)\/[A-Za-z0-9._-]+$/;
function listAssets() {
  const out = [];
  try {
    for (const f of fs.readdirSync(ASSETS_DIR)) {
      if (!/^[\u4e00-\u9fa5A-Za-z0-9._-]+$/.test(f)) continue;
      if (fs.statSync(path.join(ASSETS_DIR, f)).isFile()) out.push(f);
    }
  } catch (e) { /* 目录不存在 */ }
  try {
    for (const f of fs.readdirSync(UPLOADS_DIR)) {
      if (!/^[\u4e00-\u9fa5A-Za-z0-9._-]+$/.test(f)) continue;
      if (fs.statSync(path.join(UPLOADS_DIR, f)).isFile()) out.push('uploads/' + f);
    }
  } catch (e) { /* 目录不存在 */ }
  // ATRI 表情差分立绘（assets/atri/*.webp）
  try {
    const atriDir = path.join(ASSETS_DIR, 'atri');
    for (const f of fs.readdirSync(atriDir)) {
      if (!/^[\u4e00-\u9fa5A-Za-z0-9._-]+$/.test(f)) continue;
      if (fs.statSync(path.join(atriDir, f)).isFile()) out.push('atri/' + f);
    }
  } catch (e) { /* 目录不存在 */ }
  // 内置鲸鱼娘素材（assets/whale/*.webp：立绘表情/姿势/胸像/场景/壁纸）
  try {
    const whaleDir = path.join(ASSETS_DIR, 'whale');
    for (const f of fs.readdirSync(whaleDir)) {
      if (!/^[\u4e00-\u9fa5A-Za-z0-9._-]+$/.test(f)) continue;
      if (fs.statSync(path.join(whaleDir, f)).isFile()) out.push('whale/' + f);
    }
  } catch (e) { /* 目录不存在 */ }
  return out;
}
const ASSET_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif',
  '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.wav': 'audio/wav', '.webm': 'video/webm',
};
function serveAsset(res, name) {
  if (!SERVE_NAME.test(name) && !SERVE_AUDIO_NAME.test(name)) { res.writeHead(400); res.end('bad name'); return; }
  const p = path.resolve(ASSETS_DIR, name);
  if (!p.startsWith(ASSETS_DIR + path.sep)) { res.writeHead(400); res.end('bad path'); return; }
  let st;
  try { st = fs.statSync(p); } catch (e) { res.writeHead(404); res.end('missing'); return; }
  if (!st.isFile()) { res.writeHead(404); res.end('missing'); return; }
  const type = ASSET_TYPES[path.extname(name).toLowerCase()];
  if (!type) { res.writeHead(404); res.end('unsupported type'); return; }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-store' });
  fs.createReadStream(p).pipe(res);
}

/* ---------- 图片校验与保存 ---------- */

function imageExt(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.length >= 6 && (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a')) return 'gif';
  return null;
}
function saveImage(buf) {
  const ext = imageExt(buf);
  if (!ext) throw httpError(400, '文件不是有效的 PNG / JPEG / WebP / GIF 图片');
  if (buf.length > MAX_UPLOAD_BYTES) throw httpError(413, '图片超过 12 MB 上限');
  const name = 'up_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8) + '.' + ext;
  fs.writeFileSync(localPath('assets/uploads/' + name), buf);
  return 'uploads/' + name;
}
function decodeDataUrl(data) {
  const m = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(data || ''));
  if (!m) throw httpError(400, '请上传 PNG / JPEG / WebP / GIF 图片');
  const buf = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
  if (!buf.length) throw httpError(400, '图片内容为空');
  if (buf.length > MAX_UPLOAD_BYTES) throw httpError(413, '图片超过 12 MB 上限');
  return buf;
}

/* ---------- 自定义 BGM 上传 ---------- */
function audioExt(buf) {
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'OggS') return 'ogg';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xfb) return 'mp3';
  if (buf.length >= 3 && buf.toString('ascii', 0, 3) === 'ID3') return 'mp3';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') return 'wav';
  if (buf.length >= 4 && buf.toString('ascii', 4, 8) === 'ftyp') return 'm4a';
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'fLaC') return 'flac';
  return null;
}
const AUDIO_IDX_FILE = localPath('assets/audio/index.json');
function loadAudioIdxRaw() {
  try { const j = JSON.parse(fs.readFileSync(AUDIO_IDX_FILE, 'utf8')); return j && typeof j === 'object' ? j : {}; }
  catch (e) { return {}; }
}
function saveAudioIdxRaw(j) { fs.writeFileSync(AUDIO_IDX_FILE, JSON.stringify(j, null, 2) + '\n', 'utf8'); }
function saveCustomBgm(dataUrl) {
  const m = /^data:audio\/(?:mpeg|mp3|ogg|wav|mp4|x-m4a|flac|webm);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ''));
  if (!m) throw httpError(400, '请上传有效的音频文件（MP3 / OGG / WAV / M4A / FLAC）');
  const buf = Buffer.from(m[1].replace(/\s/g, ''), 'base64');
  if (!buf.length) throw httpError(400, '音频内容为空');
  if (buf.length > MAX_UPLOAD_BYTES) throw httpError(413, '音频超过 12 MB 上限');
  const ext = audioExt(buf);
  if (!ext) throw httpError(400, '无法识别的音频格式，支持 MP3 / OGG / WAV / M4A / FLAC');
  const name = 'upload_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8) + '.' + ext;
  fs.mkdirSync(localPath('assets/audio/bgm'), { recursive: true });
  fs.writeFileSync(localPath('assets/audio/bgm/' + name), buf);
  const rel = 'audio/bgm/' + name;
  const j = loadAudioIdxRaw();
  if (!j.bgm || typeof j.bgm !== 'object') j.bgm = {};
  if (!Array.isArray(j.bgm.custom)) j.bgm.custom = [];
  if (j.bgm.custom.indexOf(rel) < 0) j.bgm.custom.push(rel);
  saveAudioIdxRaw(j);
  return { ok: true, file: rel, bytes: buf.length };
}
function deleteCustomBgm(file) {
  file = String(file || '');
  if (!/^audio\/bgm\/upload_[A-Za-z0-9._-]+$/.test(file)) throw httpError(400, '只能删除自己上传的 BGM');
  const p = path.resolve(ASSETS_DIR, file);
  if (!p.startsWith(ASSETS_DIR + path.sep)) throw httpError(400, '非法路径');
  try { fs.unlinkSync(p); } catch (e) { /* 已不存在 */ }
  const j = loadAudioIdxRaw();
  if (j.bgm && Array.isArray(j.bgm.custom)) {
    j.bgm.custom = j.bgm.custom.filter((x) => x !== file);
    saveAudioIdxRaw(j);
  }
  return { ok: true, removed: file };
}

/* ---------- 素材槽位：上传时指派 / 已有文件指派 / 删除上传文件 ---------- */

const ASSETS_FILE = localPath('assets.json');
const ASSET_SLOTS = [
  'background.day', 'background.dusk', 'background.night',
  'portrait.idle', 'portrait.happy', 'portrait.sad', 'portrait2.idle',
];
const ASSET_GROUPS = {
  'background.all': ['background.day', 'background.dusk', 'background.night'],
  'portrait.all': ['portrait.idle', 'portrait.happy', 'portrait.sad'],
};
function resolveSlots(slot) {
  if (ASSET_GROUPS[slot]) return ASSET_GROUPS[slot];
  if (ASSET_SLOTS.indexOf(slot) >= 0) return [slot];
  return null;
}
function loadAssetsRaw() {
  try {
    const j = JSON.parse(fs.readFileSync(ASSETS_FILE, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch (e) { return {}; }
}
function saveAssetsRaw(a) {
  fs.writeFileSync(ASSETS_FILE, JSON.stringify(a, null, 2) + '\n', 'utf8');
  cache = { at: 0, value: null };
}
function setAssetSlots(slot, file) {
  const slots = resolveSlots(slot);
  if (!slots) throw httpError(400, '未知的素材槽位：' + String(slot).slice(0, 60));
  file = typeof file === 'string' ? file : '';
  // 只允许指向素材目录里确实存在的文件；空字符串表示清空该槽位。
  if (file && (!ASSET_NAME.test(file) || listAssets().indexOf(file) < 0)) {
    throw httpError(400, '素材文件不存在或名称不合法');
  }
  const raw = loadAssetsRaw();
  for (const s of slots) {
    const parts = s.split('.');
    const group = parts[0], key = parts[1];
    if (!raw[group] || typeof raw[group] !== 'object' || Array.isArray(raw[group])) raw[group] = {};
    raw[group][key] = file;
  }
  // 兼容旧字段 settings.portrait（写入但不用于覆盖），让旧接口与槽位分配保持一致
  if (slots.indexOf('portrait.idle') >= 0) {
    SETTINGS.portrait = file;
    saveSettings(SETTINGS);
  }
  // 手动改了背景槽位，就把场景钉到「自定义」，否则用户看不到自己换的图
  if (slots.some((s) => s.indexOf('background.') === 0)) {
    const prev = raw.scenes && typeof raw.scenes === 'object' && !Array.isArray(raw.scenes) ? raw.scenes : {};
    raw.scenes = Object.assign({}, prev, { pin: 'custom' });
  }
  saveAssetsRaw(raw);
  return Object.assign({ ok: true, slot, file }, assetsPayload());
}
function deleteUploaded(file) {
  if (!/^uploads\/[A-Za-z0-9._-]+$/.test(file)) throw httpError(400, '只能删除 assets/uploads/ 下的上传素材');
  const p = path.resolve(ASSETS_DIR, file);
  if (!p.startsWith(UPLOADS_DIR + path.sep)) throw httpError(400, '非法路径');
  const raw = loadAssetsRaw();
  let cleared = 0;
  for (const group of ['background', 'portrait', 'portrait2', 'ui', 'audio']) {
    const g = raw[group];
    if (!g || typeof g !== 'object' || Array.isArray(g)) continue;
    for (const key of Object.keys(g)) {
      if (g[key] === file) { g[key] = ''; cleared += 1; }
    }
  }
  if (SETTINGS.portrait === file) { SETTINGS.portrait = ''; saveSettings(SETTINGS); }
  try { fs.unlinkSync(p); }
  catch (e) { if (e.code !== 'ENOENT') throw httpError(500, '删除文件失败：' + e.message); }
  saveAssetsRaw(raw);
  return Object.assign({ ok: true, file, cleared }, assetsPayload());
}
function uploadAsset(body) {
  const slot = typeof body.slot === 'string' && body.slot ? body.slot : 'portrait.idle';
  if (slot !== '__library__' && !resolveSlots(slot)) {
    throw httpError(400, '未知的素材槽位：' + slot.slice(0, 60));
  }
  const buf = decodeDataUrl(body.data);
  const file = saveImage(buf);
  const base = {
    ok: true, file, url: '/assets/' + file, bytes: buf.length,
    name: String(body.name || '').slice(0, 120), slot,
  };
  if (slot === '__library__') return Object.assign(base, assetsPayload());
  const out = setAssetSlots(slot, file);
  return Object.assign(base, { config: out.config, files: out.files, scenes: out.scenes });
}

/* ---------- 外部 API 代理（图片生成 / 语音合成等，仅主动触发） ---------- */

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
function redact(s) { return String(s || '').replace(/sk-[A-Za-z0-9_\-]{6,}/g, 'sk-***').slice(0, 400); }
/* 日志里只留 origin + path，去掉可能夹带凭据的 userinfo 与查询串 */
function redactUrl(u) {
  try { const x = new URL(String(u || '')); return x.origin + x.pathname; }
  catch (e) { return String(u || '').slice(0, 120); }
}
function joinUrl(base, tailPath) {
  const raw = String(base || '').trim();
  if (!/^https?:\/\//i.test(raw)) throw httpError(400, '接口地址必须是 http:// 或 https:// 开头');
  let u;
  try { u = new URL(raw); } catch (e) { throw httpError(400, '接口地址不是合法 URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw httpError(400, '接口地址只支持 http / https');
  if (u.username || u.password) throw httpError(400, '接口地址里不要带用户名密码');
  return raw.replace(/\/+$/, '') + '/' + tailPath;
}
const PROXY_MAX_REDIRECTS = 3;
/* 外部请求统一走这里。redirect 固定 manual：不让运行时带着 Authorization 头
 * 自动跟到别的站点——那等于把 API Key 送给重定向目标。跨域重定向默认拒绝，
 * 只有「本来就无凭据的下载」（例如模型返回的图片 URL）才允许跨域跟随。 */
async function proxyFetch(url, opts, timeoutMs) {
  let target = String(url);
  let method = opts.method || 'GET';
  let body = opts.body;
  const headers = Object.assign({}, opts.headers || {});
  for (let hop = 0; ; hop++) {
    const r = await fetch(target, {
      method: method,
      headers: headers,
      body: body,
      signal: AbortSignal.timeout(timeoutMs || 60000),
      redirect: 'manual',
    });
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location');
      if (!loc) throw httpError(502, '接口返回了重定向，但没给 Location');
      if (hop >= PROXY_MAX_REDIRECTS) throw httpError(502, '接口重定向次数过多');
      const from = new URL(target);
      let next;
      try { next = new URL(loc, target); } catch (e) { throw httpError(502, '接口给了一个无法解析的重定向地址'); }
      if (next.protocol !== 'http:' && next.protocol !== 'https:') throw httpError(502, '接口重定向到了不支持的协议');
      if (next.origin !== from.origin) {
        if (!opts.allowCrossRedirect) {
          throw httpError(502, '接口把请求重定向到了别的站点（' + next.origin + '），已拒绝，避免 API Key 被转发出去。请把「接口地址」直接填成最终地址。');
        }
        /* 无凭据的下载：可以跟，但把可能存在的 Authorization 去掉，绝不带到新站点 */
        delete headers.Authorization;
        delete headers.authorization;
      }
      if (r.status === 301 || r.status === 302 || r.status === 303) { method = 'GET'; body = undefined; }
      target = next.href;
      continue;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    let json = null;
    try { json = JSON.parse(buf.toString('utf8')); } catch (e) { /* 二进制 */ }
    return { ok: r.ok, status: r.status, buffer: buf, json, text: buf.toString('utf8'), contentType: r.headers.get('content-type') || '' };
  }
}

async function generateImage(body) {
  const prompt = String(body.prompt || '').trim().slice(0, 2000);
  if (!prompt) throw httpError(400, '请先写一句画面描述');
  const slot = typeof body.slot === 'string' && body.slot ? body.slot
    : (body.setAsPortrait === false ? '__library__' : 'portrait.idle');
  if (slot !== '__library__' && !resolveSlots(slot)) throw httpError(400, '未知的素材槽位：' + slot.slice(0, 60));
  const cfg = SETTINGS.image;
  const key = cfg.apiKey || process.env.FISH_IMAGE_API_KEY || '';
  if (!key) throw httpError(400, '尚未配置图片模型密钥：在「设置 → 立绘 → 图片模型」填 API Key，或设置环境变量 FISH_IMAGE_API_KEY');
  const endpoint = joinUrl(cfg.baseUrl, 'images/generations');
  const payload = { model: cfg.model, prompt, n: 1, size: cfg.size };
  if (cfg.responseFormat === 'b64_json') payload.response_format = 'b64_json';
  let r;
  try {
    r = await proxyFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify(payload),
    }, 150000);
  } catch (e) { throw httpError(502, '图片模型请求失败：' + redact(e.message)); }
  if (!r.ok) throw httpError(502, '图片模型返回 ' + r.status + '：' + redact(r.json && r.json.error ? (r.json.error.message || JSON.stringify(r.json.error)) : r.text));

  const d = r.json || {};
  const first = (Array.isArray(d.data) && d.data[0]) || (Array.isArray(d.images) && d.images[0]) || {};
  const output = (d.output && (d.output.results || d.output.images)) || null;
  const outFirst = Array.isArray(output) && output[0] ? output[0] : {};
  let buf = null;
  if (first.b64_json) buf = Buffer.from(first.b64_json, 'base64');
  else if (outFirst.b64_json) buf = Buffer.from(outFirst.b64_json, 'base64');
  else if (d.b64_json) buf = Buffer.from(d.b64_json, 'base64');
  else {
    const imgUrl = first.url || outFirst.url || (typeof d.url === 'string' ? d.url : null);
    if (imgUrl) {
      if (!/^https?:\/\//i.test(imgUrl)) throw httpError(502, '模型返回的图片地址不是 http(s)');
      try { buf = (await proxyFetch(imgUrl, { allowCrossRedirect: true }, 60000)).buffer; }
      catch (e) { throw httpError(502, '下载生成图片失败：' + redact(e.message)); }
    }
  }
  if (!buf || !buf.length) throw httpError(502, '没能从模型响应中取到图片（既无 b64_json 也无 url）');
  const file = saveImage(buf);
  const base = { ok: true, file, url: '/assets/' + file, bytes: buf.length, model: cfg.model, prompt, slot };
  if (slot === '__library__') return Object.assign(base, assetsPayload());
  const out = setAssetSlots(slot, file);
  return Object.assign(base, { config: out.config, files: out.files, scenes: out.scenes });
}

async function synthSpeech(body) {
  const text = String(body.text || '').trim().slice(0, 1000);
  if (!text) throw httpError(400, '没有需要朗读的文字');
  const engine = oneOf(body.engine, ['server', 'sovits'], (SETTINGS.tts && SETTINGS.tts.engine) || 'server');
  if (engine === 'sovits') return synthSoVits(text, body);
  const cfg = SETTINGS.serverTts;
  const key = cfg.apiKey || process.env.FISH_TTS_API_KEY || '';
  if (!key) throw httpError(400, '尚未配置语音模型密钥：在「设置 → 语音」填 API Key，或设置环境变量 FISH_TTS_API_KEY。也可以改用免配置的「浏览器语音」。');
  const endpoint = joinUrl(cfg.baseUrl, 'audio/speech');
  let r;
  try {
    r = await proxyFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({ model: cfg.model, voice: cfg.voice, input: text, response_format: cfg.format }),
    }, 60000);
  } catch (e) { throw httpError(502, '语音模型请求失败：' + redact(e.message)); }
  if (!r.ok) throw httpError(502, '语音模型返回 ' + r.status + '：' + redact(r.json && r.json.error ? (r.json.error.message || JSON.stringify(r.json.error)) : r.text));
  if (!r.buffer.length) throw httpError(502, '语音模型返回了空音频');
  return { buffer: r.buffer, type: { mp3: 'audio/mpeg', wav: 'audio/wav', opus: 'audio/ogg', aac: 'audio/aac', flac: 'audio/flac' }[cfg.format] || 'audio/mpeg' };
}

/* ---------- 本地 GPT-SoVITS（api_v2.py / api.py） ---------- */

function sovitsPayload(text, cfg) {
  const p = {
    text: text,
    text_lang: cfg.textLang,
    top_k: Math.round(cfg.topK),
    top_p: cfg.topP,
    temperature: cfg.temperature,
    text_split_method: cfg.splitMethod,
    batch_size: Math.round(cfg.batchSize),
    speed_factor: cfg.speed,
    media_type: cfg.mediaType,
    streaming_mode: !!cfg.streaming,
  };
  if (cfg.refAudioPath) {
    p.ref_audio_path = cfg.refAudioPath;
    if (cfg.promptText) {
      p.prompt_text = cfg.promptText;
      p.prompt_lang = cfg.promptLang;
    }
  }
  return p;
}

function sovitsErrorText(r) {
  const j = r.json || {};
  const msg = j.message || j.detail || j.error || (r.ok ? '' : r.text);
  return redact(typeof msg === 'string' ? msg : JSON.stringify(msg)).slice(0, 400);
}

async function synthSoVits(text, body) {
  const cfg = normalizeSovits(body && body.sovits, SETTINGS.sovits || DEFAULT_SETTINGS.sovits);
  const timeoutMs = Math.round(cfg.timeoutSec * 1000);
  const endpoint = joinUrl(cfg.baseUrl, 'tts');
  const payload = sovitsPayload(text, cfg);
  const where = cfg.baseUrl.replace(/\/+$/, '');

  /* api_v2 没有免参考文本模式：v2Pro/v3 用了 vocoder，prompt_text 为空会直接报错 */
  if (!cfg.refAudioPath) {
    throw httpError(400, 'GPT-SoVITS 需要参考音频：请在设置里填一段 3–10 秒 wav 的本机绝对路径。');
  }
  if (!cfg.promptText) {
    throw httpError(400, 'GPT-SoVITS 需要参考台词：请填这段参考音频里逐字对应的原话（api_v2 不支持免参考文本）。');
  }
  /* 本机 SoVITS 才检查文件是否存在；远程服务上的路径由对方机器负责 */
  const localSovits = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(cfg.baseUrl);
  if (localSovits && !fs.existsSync(cfg.refAudioPath)) {
    throw httpError(400, '参考音频不存在：' + cfg.refAudioPath + '（换了电脑后，请在「设置 → 语音 → 本地 GPT-SoVITS」重新选一段本机 wav，并填上对应台词）');
  }

  let r;
  try {
    r = await proxyFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, timeoutMs);
  } catch (e) {
    throw httpError(502, '连不上本地 GPT-SoVITS（' + where + '）：' + redact(e.message)
      + '。确认已运行 api_v2.py -a 127.0.0.1 -p 9880，且地址端口填得一致。');
  }

  /* 老版本 api.py 只认 GET 查询参数，遇到 404/405 时自动降级重试一次 */
  if (r.status === 404 || r.status === 405) {
    const q = new URLSearchParams();
    Object.keys(payload).forEach(function (k) {
      const v = payload[k];
      if (v === undefined || v === null || v === '') return;
      q.set(k, typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v));
    });
    try {
      r = await proxyFetch(endpoint + '?' + q.toString(), { method: 'GET' }, timeoutMs);
    } catch (e) {
      throw httpError(502, '连不上本地 GPT-SoVITS（' + where + '）：' + redact(e.message));
    }
  }

  const ct = String(r.contentType || '').toLowerCase();
  /* 出错时 GPT-SoVITS 会用 JSON 回包，哪怕是 200 */
  if (!r.ok || ct.indexOf('json') >= 0) {
    const msg = sovitsErrorText(r);
    if (!r.ok) throw httpError(502, 'GPT-SoVITS 返回 ' + r.status + '：' + (msg || '无错误信息'));
    throw httpError(502, 'GPT-SoVITS 没有返回音频：' + (msg || '响应是 JSON'));
  }
  if (!r.buffer || !r.buffer.length) throw httpError(502, 'GPT-SoVITS 返回了空音频');

  const type = ct && ct.indexOf('audio/') === 0 ? ct.split(';')[0] : (SOVITS_CT[cfg.mediaType] || 'audio/wav');
  return { buffer: r.buffer, type: type, engine: 'sovits' };
}

/* 测试连通性：真发一句极短的合成，能同时验证服务、参考音频和参数 */
async function probeSoVits(body) {
  const cfg = normalizeSovits(body && body.sovits, SETTINGS.sovits || DEFAULT_SETTINGS.sovits);
  if (!/^https?:\/\//i.test(cfg.baseUrl)) throw httpError(400, '服务地址必须是 http:// 或 https:// 开头');
  const t0 = Date.now();
  const out = await synthSoVits('嗯，我在。', { sovits: cfg });
  return {
    ok: true,
    baseUrl: cfg.baseUrl.replace(/\/+$/, ''),
    bytes: out.buffer.length,
    type: out.type,
    elapsedMs: Date.now() - t0,
    refAudioPath: cfg.refAudioPath || '',
  };
}

/* ---------- 对话：DSH 桥 / 第三方 OpenAI 兼容 API ---------- */

const CHAT_LOG_MAX = 240;
let CHAT_LOG = loadChatLog();
let chatBusy = false;
let chatPending = null;   // 超时后仍在线等的那条：{sessionId, cursor, text, at}
/* 清空记录 / 切换目标时递增，用来作废仍在飞行中的等待与轮询：
 * 旧请求返回后只比对 epoch，不再直接写 chatPending.cursor（它可能已被清空）。 */
let chatEpoch = 0;
function resetChatPending() { chatPending = null; chatEpoch++; }
/* 本进程刚建出来的会话：DSH 的 bootstrap 有时慢半拍，先自己记住，保证马上能选中并发话 */
const createdDshSessions = new Map();

function chatLogPath() { return localPath('chat-log.json'); }
function loadChatLog() {
  try {
    const a = JSON.parse(fs.readFileSync(chatLogPath(), 'utf8'));
    return Array.isArray(a) ? a.filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string').slice(-CHAT_LOG_MAX) : [];
  } catch (e) { return []; }
}
function saveChatLog() {
  try { fs.writeFileSync(chatLogPath(), JSON.stringify(CHAT_LOG.slice(-CHAT_LOG_MAX)), 'utf8'); } catch (e) { /* 本地记录失败不影响对话 */ }
}
function pushChat(role, text, extra) {
  const row = { role, text: String(text || '').slice(0, 4000), at: Date.now() };
  if (extra && extra.pending) row.pending = true;
  if (extra && extra.error) row.error = true;
  CHAT_LOG.push(row);
  CHAT_LOG = CHAT_LOG.slice(-CHAT_LOG_MAX);
  saveChatLog();
  return row;
}
function chatLogTail(n) { return CHAT_LOG.slice(-(n || 40)); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function dshEndpoint() {
  const c = (SETTINGS && SETTINGS.chat) || DEFAULT_SETTINGS.chat;
  let base = String(c.dshBaseUrl || DEFAULT_SETTINGS.chat.dshBaseUrl).trim().replace(/\/+$/, '');
  if (base && !/^https?:\/\//i.test(base)) base = 'http://' + base;   /* 允许只填 192.168.1.20:3080 */
  if (!base) base = DEFAULT_SETTINGS.chat.dshBaseUrl;
  let token = c.dshToken || '';
  if (!token) {
    try { token = fs.readFileSync(path.join(ROOT, 'mobile-remote', 'auth-token'), 'utf8').trim(); } catch (e) { token = ''; }
  }
  return { base, token };
}

async function dshCall(tail, opt, timeoutMs) {
  const { base, token } = dshEndpoint();
  if (!token) throw httpError(400, '读不到 DSH 访问口令：~/.dsh/mobile-remote/auth-token 不存在或为空。请确认 DSH 的「连接移动端设备」已启用。');
  const body = opt && opt.body ? JSON.stringify(opt.body) : undefined;
  const headers = { 'x-mobile-token': token };
  if (body) headers['Content-Type'] = 'application/json';
  let r;
  try {
    r = await proxyFetch(base + tail, { method: (opt && opt.method) || 'GET', headers, body }, timeoutMs || 15000);
  } catch (e) {
    throw httpError(502, '连不上 DSH（' + redact(e.message) + '）。确认 DSH 正在运行，且「设置 → 对话 → DSH 地址」和 DSH 的移动桥端口一致（默认 http://127.0.0.1:3080/m/api）。');
  }
  if (!r.ok) {
    const j = r.json || {};
    const msg = j.detail || j.error || r.text || ('HTTP ' + r.status);
    throw httpError(502, 'DSH 返回 ' + r.status + '：' + redact(msg));
  }
  return r.json || {};
}

async function dshSessions() {
  const boot = await dshCall('/bootstrap', null, 8000);
  const agents = Array.isArray(boot.agents) ? boot.agents : [];
  const list = agents.map(a => ({
    id: String(a.sessionId || ''),
    agentId: a.id || a.sessionId,
    title: a.title || a.name || a.sessionId,
    status: a.status || '',
    cwd: a.cwd || '',
  })).filter(s => s.id);
  /* 本进程新建的会话只在 bootstrap 还没露出来的那段时间兜底；
   * 一旦 DSH 自己列出了它，就撤掉兜底，避免它被删除后还长期挂在列表里当幽灵会话。 */
  createdDshSessions.forEach((s, key) => {
    if (list.some(x => x.id === s.id || x.agentId === s.id)) { createdDshSessions.delete(key); return; }
    list.unshift(Object.assign({}, s));
  });
  return { list, server: boot.server || {} };
}

function pathForMatch(p) {
  return String(p || '').replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase();
}
function pathContains(parent, child) {
  const a = pathForMatch(parent), b = pathForMatch(child);
  if (!a || !b) return false;
  return b === a || b.startsWith(a + '\\');
}
async function dshWorkspaces() {
  try {
    const j = await dshCall('/workspaces', null, 8000);
    return Array.isArray(j.workspaces) ? j.workspaces.filter(w => w && w.path) : [];
  } catch (e) { return []; }
}
/* 在 DSH 所在机器上新建一个目录并建会话：DSH 会把这个目录注册成独立工作区。 */
async function createDshWorkspace() {
  const st = await dshSessions();
  const current = pickDshSession(st.list);
  const workspaces = await dshWorkspaces();
  let base = '';
  if (current && current.cwd) {
    const hit = workspaces.find(w => pathContains(w.path, current.cwd));
    base = hit ? hit.path : current.cwd;
  }
  if (!base && workspaces.length) base = workspaces[0].path;
  if (!base) throw httpError(400, 'DSH 里还没有可用工作区。请先在 DSH 建一个会话或工作区，再从这里新建。');

  const d = new Date();
  const p2 = n => String(n).padStart(2, '0');
  const stamp = d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
  let name = 'fishwatch-' + stamp;
  let made = null;
  for (let i = 0; i < 5; i++) {
    try {
      made = await dshCall('/directories', { method: 'POST', body: { path: base, name } }, 10000);
      break;
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/EEXIST|already exists|mkdir-failed/i.test(msg) && i < 4) name = 'fishwatch-' + stamp + '-' + (i + 2);
      else throw e;
    }
  }
  if (!made || !made.path) throw httpError(502, 'DSH 没有返回新建的工作区目录');

  const created = await dshCall('/sessions', {
    method: 'POST', body: { cwd: made.path },
  }, 30000);
  const sessionId = String(created.sessionId || '');
  if (!sessionId) throw httpError(502, 'DSH 建好了目录，但没有返回会话 id');
  createdDshSessions.set(sessionId, {
    id: sessionId, agentId: created.agentId || sessionId,
    title: name, status: 'idle', cwd: made.path,
  });

  SETTINGS = saveSettings(mergeSettings({
    chat: { dshSessionId: sessionId },
  }, SETTINGS));
  cache = { at: 0, value: null };
  CHAT_LOG = [];
  resetChatPending();
  saveChatLog();
  return {
    ok: true, sessionId, agentId: created.agentId || sessionId,
    title: name, cwd: made.path,
  };
}

/* 目标会话：设置里明确指定过，就只认那一个；只有从未选过时才默认列表第一个。
 * 明确指定却找不到（被删 / 改名 / DSH 重启换了 id）返回 null，由调用方提示重选，
 * 绝不悄悄换成别的会话，避免把私人对话发给另一个 Agent。 */
function dshSessionOf(list, want) {
  if (!want) return null;
  return list.find(s => s.id === want || s.agentId === want) || null;
}
function pickDshSession(list) {
  const want = (SETTINGS.chat && SETTINGS.chat.dshSessionId) || '';
  if (want) return dshSessionOf(list, want);
  return list[0] || null;
}
function hasPinnedDshSession() {
  return !!((SETTINGS.chat && SETTINGS.chat.dshSessionId) || '');
}
function dshSessionLostError() {
  return httpError(409, '设置里选定的 DSH 会话已经不在列表里（可能被删除、改名，或 DSH 重启后换了 id）。请在对话面板顶部的会话下拉里重新选一个目标，再发送。');
}
/* 这次等待被作废（清空记录 / 切换目标）：回一个统一结构，调用方不再写记录 */
function cancelledChat(target) {
  return {
    reply: '', done: false, cancelled: true,
    sessionId: target ? target.id : '',
    sessionTitle: target ? target.title : '',
  };
}
/* 从未选过时把当前默认会话记下来：从此目标是确定的，列表变化会明确报错而不是漂移。
 * 只是加固，不参与发送成败——落盘失败就当没记住，这次照常发。 */
function pinDshSession(session) {
  if (!session || hasPinnedDshSession()) return;
  try {
    SETTINGS = saveSettings(mergeSettings({ chat: { dshSessionId: session.id } }, SETTINGS));
    cache = { at: 0, value: null };
  } catch (e) { /* 设置写不进去也不影响这次发送 */ }
}

async function dshHistoryPage(sessionId, after, limit) {
  let q = '/history?sessionId=' + encodeURIComponent(sessionId) + '&limit=' + (limit || 200);
  if (after) q += '&after=' + Math.max(0, Math.floor(after));
  return dshCall(q, null, 12000);
}

/* 轮询新事件：抓最后一条有文字的 assistant/message；turn/end 视为本轮收尾 */
async function dshCollect(sessionId, cursor) {
  const page = await dshHistoryPage(sessionId, cursor, 200);
  const evs = Array.isArray(page.events) ? page.events : [];
  let reply = '', ended = false, next = cursor;
  for (const e of evs) {
    const seq = Number(e && e.seq) || 0;
    if (seq > next) next = seq;
    if (e && e.type === 'assistant/message' && e.data && typeof e.data.text === 'string' && e.data.text.trim()) reply = e.data.text.trim();
    if (e && e.type === 'turn/end') ended = true;
  }
  return { reply, ended, cursor: next };
}

async function chatViaDsh(text) {
  const epoch = chatEpoch;   /* 发送期间若被「清空记录 / 切换目标」作废，就整条放弃 */
  /* 目标在入口就定下来：之后一律用它，不读可能已经变了的 SETTINGS */
  const wantAtStart = (SETTINGS.chat && SETTINGS.chat.dshSessionId) || '';
  const st = await dshSessions();
  /* 取列表期间被切换 / 清空：这句话还没发出去，直接放弃，绝不能按新设置改投别人 */
  if (epoch !== chatEpoch) return cancelledChat(null);
  const target = wantAtStart ? dshSessionOf(st.list, wantAtStart) : (st.list[0] || null);
  if (!target) {
    if (wantAtStart) throw dshSessionLostError();
    throw httpError(400, 'DSH 里没有可对话的会话：先在 DSH 里建一个会话，或在「设置 → 对话」里选目标会话。');
  }
  pinDshSession(target);

  let cursor = 0;
  try {
    const tail = await dshHistoryPage(target.id, 0, 1);
    const evs = Array.isArray(tail.events) ? tail.events : [];
    if (evs.length) cursor = Number(evs[evs.length - 1].seq) || 0;
  } catch (e) { /* 老会话没有历史也能发 */ }

  /* 读历史期间被切换：发出去之前的最后一道闸，宁可这条不发也不投错人 */
  if (epoch !== chatEpoch) return cancelledChat(target);

  const requestId = 'fw-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  await dshCall('/send', { method: 'POST', body: { sessionId: target.id, text, requestId } }, 25000);

  const timeoutMs = (SETTINGS.chat.replyTimeoutSec || 100) * 1000;
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    await sleep(1100);
    if (epoch !== chatEpoch) return cancelledChat(target);
    let got;
    try { got = await dshCollect(target.id, cursor); }
    catch (e) { continue; }
    /* 读回复期间被清空 / 切换：这批结果整批丢弃，不能等下一轮再判断 */
    if (epoch !== chatEpoch) return cancelledChat(target);
    cursor = got.cursor;
    if (got.reply) last = got.reply;
    if (got.ended && last) return { reply: last, sessionId: target.id, sessionTitle: target.title, done: true };
  }
  /* 最后一轮读到的内容同样要先确认没被作废，再决定返回还是挂起 */
  if (epoch !== chatEpoch) return cancelledChat(target);
  if (last) return { reply: last, sessionId: target.id, sessionTitle: target.title, done: false };
  chatPending = { sessionId: target.id, cursor, text, at: Date.now() };
  return { reply: '', sessionId: target.id, sessionTitle: target.title, pending: true };
}

async function pollChatPending() {
  const job = chatPending;
  if (!job) return { ok: true, pending: false, reply: '' };
  const epoch = chatEpoch;
  if (Date.now() - job.at > 6 * 60 * 1000) {
    if (chatPending === job) chatPending = null;
    return { ok: true, pending: false, reply: '' };
  }
  let got;
  try { got = await dshCollect(job.sessionId, job.cursor); }
  catch (e) {
    if (chatPending !== job || epoch !== chatEpoch) return { ok: true, pending: false, reply: '', cancelled: true };
    return { ok: true, pending: true, reply: '', error: redact(e.message) };
  }
  /* 等待期间被清空记录 / 切换会话作废：丢弃这次结果，不写回、不弹回复 */
  if (chatPending !== job || epoch !== chatEpoch) return { ok: true, pending: false, reply: '', cancelled: true };
  job.cursor = got.cursor;
  if (got.reply) {
    const r = got.reply;
    chatPending = null;
    pushChat('assistant', r);
    return { ok: true, pending: false, reply: r, done: got.ended, log: chatLogTail(20) };
  }
  return { ok: true, pending: true, reply: '' };
}

async function chatStatePayload() {
  const c = SETTINGS.chat;
  const out = {
    ok: true,
    busy: chatBusy,
    pending: !!chatPending,
    dsh: { baseUrl: c.dshBaseUrl, sessionId: c.dshSessionId || '', sessions: [], error: '', tokenReady: !!dshEndpoint().token },
    log: chatLogTail(40),
  };
  try {
    const st = await dshSessions();
    out.dsh.sessions = st.list;
    const pick = pickDshSession(st.list);
    out.dsh.selected = pick ? pick.id : '';
    out.dsh.selectedTitle = pick ? pick.title : '';
    /* 明确选过但已经不在列表：界面要提示重选，不能假装选中了第一个 */
    out.dsh.staleSession = !pick && hasPinnedDshSession();
  } catch (e) {
    out.dsh.error = redact(e.message);
  }
  return out;
}

/* ---------- 本地 GPT-SoVITS 拉起与状态 ----------
 * 默认「不自动启动」：启动脚本属于本机可执行文件，是否执行交给用户点一下。
 * 只有设置里打开「自动启动本地 SoVITS」，或用户主动点「启动」时才拉起。
 * 目录只认三类显式位置（环境变量 / 程序目录 / 用户目录），不再全盘扫描盘符。
 */
const SOVITS_STATE = { status: 'idle', detail: '', startedAt: 0, pid: 0, detected: '', dir: '' };
function portOpen(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { sock.destroy(); } catch (e) {} resolve(v); } };
    sock.setTimeout(timeoutMs || 800);
    sock.on('connect', () => finish(true));
    sock.on('error', () => finish(false));
    sock.on('timeout', () => finish(false));
    try { sock.connect(port, host); } catch (e) { finish(false); }
  });
}
function sovitsEndpoint() {
  const cfg = (SETTINGS && SETTINGS.sovits) || DEFAULT_SETTINGS.sovits || {};
  return String(cfg.baseUrl || 'http://127.0.0.1:9880');
}
function parseHostPort(url) {
  try {
    const u = new URL(url);
    /* Node 对 IPv6 会返回带方括号的 [::1]，统一去掉方便比较 */
    const host = String(u.hostname || '127.0.0.1').replace(/^\[|\]$/g, '');
    return { host, port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)) };
  } catch (e) { return { host: '127.0.0.1', port: 9880 }; }
}
function sovitsCandidates() {
  return [
    process.env.FISH_SOVITS_DIR,
    path.join(APP_DIR, 'GPT-SoVITS'),
    path.join(os.homedir(), 'GPT-SoVITS'),
  ].filter(Boolean);
}
function findSoVits() {
  for (const d of sovitsCandidates()) {
    const cmd = path.join(d, 'start-sovits.cmd');
    const py = path.join(d, 'api_v2.py');
    try { if (fs.statSync(cmd).isFile()) return { dir: d, launcher: cmd, pyScript: '', path: cmd }; } catch (e) { /* 换下一个 */ }
    try { if (fs.statSync(py).isFile()) return { dir: d, launcher: '', pyScript: py, path: py }; } catch (e) { /* 换下一个 */ }
  }
  return null;
}
async function ensureSoVits(force) {
  const engine = (SETTINGS && SETTINGS.tts && SETTINGS.tts.engine) || 'browser';
  const url = sovitsEndpoint();
  const { host, port } = parseHostPort(url);
  const local = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  const reachable = await portOpen(host, port, 800);
  if (reachable) {
    SOVITS_STATE.status = 'ready';
    SOVITS_STATE.detail = '端口 ' + port + ' 已在监听';
    return SOVITS_STATE;
  }
  const found = findSoVits();
  SOVITS_STATE.detected = found ? found.path : '';
  SOVITS_STATE.dir = found ? found.dir : '';
  const auto = !!(SETTINGS && SETTINGS.sovits && SETTINGS.sovits.autoStart === true);
  if (!force && !auto) {
    SOVITS_STATE.status = 'off';
    SOVITS_STATE.detail = found
      ? '未自动启动（默认关闭）。已找到 ' + found.path + '，可在设置里点「启动本地 SoVITS」'
      : '未自动启动（默认关闭）。没找到 GPT-SoVITS：可设环境变量 FISH_SOVITS_DIR 指向安装目录';
    return SOVITS_STATE;
  }
  if (!local) {
    SOVITS_STATE.status = 'off';
    SOVITS_STATE.detail = '服务地址不是本机，无法自动启动';
    return SOVITS_STATE;
  }
  if (!force && engine !== 'sovits') {
    SOVITS_STATE.status = 'off';
    SOVITS_STATE.detail = '当前引擎不是本地 GPT-SoVITS';
    return SOVITS_STATE;
  }
  if (!found) {
    SOVITS_STATE.status = 'missing';
    SOVITS_STATE.detail = '没找到 GPT-SoVITS（可设环境变量 FISH_SOVITS_DIR 指向安装目录）';
    return SOVITS_STATE;
  }
  const dir = found.dir, launcher = found.launcher, pyScript = found.pyScript;
  SOVITS_STATE.status = 'starting';
  SOVITS_STATE.detail = '正在启动本地 GPT-SoVITS，首次加载模型约需 30–90 秒…';
  SOVITS_STATE.startedAt = Date.now();
  try {
    let child;
    if (launcher) {
      /* 有启动脚本：用 cmd /c 起独立最小化窗口；detached + unref 让它脱离本服务存活 */
      child = spawn('cmd.exe', ['/c', 'start', '""', '/min', launcher], {
        cwd: dir, detached: true, stdio: 'ignore',
      });
    } else {
      /* 只有 api_v2.py：直接找 python 解释器拉起，兼容没写启动脚本的安装 */
      const py = process.env.FISH_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
      child = spawn(py, [pyScript, '-a', host, '-p', String(port)], {
        cwd: dir, detached: true, stdio: 'ignore',
      });
    }
    SOVITS_STATE.pid = child.pid || 0;
    child.unref();
    /* 后台轮询端口，最长等 150 秒；就绪后把状态更新为 ready */
    const deadline = Date.now() + 150000;
    const poll = async () => {
      const up = await portOpen(host, port, 800);
      if (up) {
        SOVITS_STATE.status = 'ready';
        SOVITS_STATE.detail = '已连接 · ' + url;
        return;
      }
      if (Date.now() < deadline) { setTimeout(poll, 2000); }
      else {
        SOVITS_STATE.status = 'timeout';
        SOVITS_STATE.detail = '等待 150 秒仍未就绪，请检查 GPT-SoVITS 启动窗口或点「测试连接」';
      }
    };
    setTimeout(poll, 1500);
  } catch (e) {
    SOVITS_STATE.status = 'error';
    SOVITS_STATE.detail = '自动启动失败：' + e.message;
  }
}
function sovitsStatus() {
  const url = sovitsEndpoint();
  return Object.assign({
    ok: true, baseUrl: url,
    engine: (SETTINGS && SETTINGS.tts && SETTINGS.tts.engine) || 'browser',
    autoStart: !!(SETTINGS && SETTINGS.sovits && SETTINGS.sovits.autoStart),
  }, SOVITS_STATE);
}

/* ---------- HTTP 工具 ---------- */

/* 页面只与本机通信；现实天气需要三个公开接口（仅在用户开启「现实联动」时请求） */
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' https://api.open-meteo.com https://geocoding-api.open-meteo.com https://ipapi.co; font-src 'self'; base-uri 'none'";

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Security-Policy': CSP });
  res.end(body);
}
function sendError(res, e) {
  const code = e && e.status ? e.status : 500;
  if (code >= 500 && code !== 502) console.error('[fish-watch] ' + (e && e.stack ? e.stack : e));
  sendJson(res, code, { ok: false, error: e && e.message ? e.message : String(e) });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, tooLarge = false;
    req.on('data', (c) => {
      if (tooLarge) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) { tooLarge = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) return reject(httpError(413, '请求体过大（上限 18 MB）'));
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(httpError(400, '请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}
/* 素材包导入用：读取原始二进制 body，上限放宽到 128 MB */
function readBinaryBody(req) {
  const LIMIT = 128 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, tooLarge = false;
    req.on('data', (c) => {
      if (tooLarge) return;
      size += c.length;
      if (size > LIMIT) { tooLarge = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) return reject(httpError(413, '素材包过大（上限 128 MB）'));
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

async function handlePost(p, req, res) {
  const body = await readBody(req);
  if (p === '/api/settings') {
    const beforeChat = (SETTINGS.chat && SETTINGS.chat.dshSessionId) || '';
    const beforeImg = (SETTINGS.image && SETTINGS.image.baseUrl) || '';
    const beforeTts = (SETTINGS.serverTts && SETTINGS.serverTts.baseUrl) || '';
    SETTINGS = saveSettings(mergeSettings(body, SETTINGS));
    cache = { at: 0, value: null };
    /* 接口地址被改 = 密钥可能被发往别处，留一条记录便于事后追溯 */
    const afterImg = (SETTINGS.image && SETTINGS.image.baseUrl) || '';
    const afterTts = (SETTINGS.serverTts && SETTINGS.serverTts.baseUrl) || '';
    if (afterImg !== beforeImg) securityLog('settings.imageEndpoint', { from: redactUrl(beforeImg), to: redactUrl(afterImg) });
    if (afterTts !== beforeTts) securityLog('settings.ttsEndpoint', { from: redactUrl(beforeTts), to: redactUrl(afterTts) });
    /* 设置页也能改目标会话：改了就和切换一样，作废正在等待的旧请求 */
    if (String((SETTINGS.chat && SETTINGS.chat.dshSessionId) || '') !== String(beforeChat)) resetChatPending();
    return sendJson(res, 200, { ok: true, settings: publicSettings(SETTINGS) });
  }
  if (p === '/api/schedule/generate') {
    const key = String(body.date || dayKey(new Date()));
    const day = generateDay(key);
    const saved = body.save === false ? day : persistDay(day);
    return sendJson(res, 200, { ok: true, day: saved, schedule: scheduleNow() });
  }
  if (p === '/api/schedule/save') {
    const key = String(body.date || (body.day && body.day.date) || dayKey(new Date()));
    const day = saveDayInput(key, body);
    return sendJson(res, 200, { ok: true, day: day, schedule: scheduleNow() });
  }
  if (p === '/api/schedule/clear') {
    const key = String(body.date || dayKey(new Date()));
    const removed = clearFishDay(key);
    return sendJson(res, 200, { ok: true, removed: removed, schedule: scheduleNow() });
  }
  if (p === '/api/bgm/upload') {
    return sendJson(res, 200, saveCustomBgm(body.data));
  }
  if (p === '/api/bgm/delete') {
    return sendJson(res, 200, deleteCustomBgm(body.file));
  }
  if (p === '/api/upload' || p === '/api/assets/upload') {
    let slot = typeof body.slot === 'string' && body.slot ? body.slot : '';
    if (!slot) slot = body.setAsPortrait === false ? '__library__' : 'portrait.idle';
    return sendJson(res, 200, uploadAsset({ data: body.data, name: body.name, slot }));
  }
  if (p === '/api/assets/set') {
    return sendJson(res, 200, setAssetSlots(String(body.slot || ''), body.file));
  }
  if (p === '/api/form') {
    /* 角色形态切换：whale-mature / whale-chibi，以及鲸鱼娘形态是否沿用亚托莉背景 */
    const raw = loadAssetsRaw();
    if (body.form != null) {
      const f = String(body.form);
      if (['whale-mature', 'whale-chibi'].indexOf(f) < 0) throw httpError(400, '未知的角色形态');
      raw.form = f;
    }
    if (body.whaleBgFromAtri != null) raw.whaleBgFromAtri = !!body.whaleBgFromAtri;
    if (body.whaleWallpaper != null) {
      const wp = String(body.whaleWallpaper);
      raw.whaleWallpaper = /^C_壁纸0[1-4]$/.test(wp) ? wp : '';
    }
    saveAssetsRaw(raw);
    return sendJson(res, 200, Object.assign({ ok: true }, assetsPayload()));
  }
  if (p === '/api/assets/delete') {
    return sendJson(res, 200, deleteUploaded(String(body.file || '')));
  }
  if (p === '/api/scene') {
    return sendJson(res, 200, setSceneState(body || {}));
  }

  if (p === '/api/persona/upload') {
    const buf = decodeCardDataUrl(body.data);
    const card = addCard(buf, String(body.name || 'card.txt').slice(0, 160));
    return sendJson(res, 200, { ok: true, id: card.id, card });
  }
  if (p === '/api/persona') {
    return sendJson(res, 200, publicPersona(updatePersona(body)));
  }
  if (p === '/api/persona/dsh') {
    /* 会改写 DSH 的人格文件，属于越过程序自身目录的写操作：必须显式确认 */
    if (body.confirm !== true) throw httpError(400, '改写 DSH 人格需要显式确认（confirm: true）');
    const out = writeDshPersona(body);
    if (!out.unchanged) securityLog('persona.write', { id: out.id, file: out.file, chars: out.chars, backup: out.backup });
    return sendJson(res, 200, out);
  }
  if (p === '/api/diary') {
    return sendJson(res, 200, saveDiaryEntry(body));
  }
  if (p === '/api/chat/send') {
    const text = String(body.text || '').trim().slice(0, 2000);
    if (!text) throw httpError(400, '先写点什么再发');
    if (chatBusy) throw httpError(429, '上一条还在等回复，稍等一下');
    chatBusy = true;
    try {
      pushChat('user', text);
      const out = await chatViaDsh(text);
      if (out.reply) pushChat('assistant', out.reply);
      return sendJson(res, 200, Object.assign({ ok: true }, out, { log: chatLogTail(20) }));
    } finally {
      chatBusy = false;
    }
  }
  if (p === '/api/dsh/agent-state') {
    return sendJson(res, 200, setDshAgentState(body));
  }
  if (p === '/api/chat/poll') {
    return sendJson(res, 200, await pollChatPending());
  }
  if (p === '/api/chat/reset') {
    CHAT_LOG = [];
    resetChatPending();   /* 同时作废正在等待的那条：旧轮询返回后不会再写状态 */
    saveChatLog();
    return sendJson(res, 200, { ok: true, log: [] });
  }
  if (p === '/api/chat/config') {
    const before = (SETTINGS.chat && SETTINGS.chat.dshSessionId) || '';
    SETTINGS = saveSettings(mergeSettings({ chat: body.chat || body }, SETTINGS));
    cache = { at: 0, value: null };
    /* 目标会话换了：上一条的等待属于旧会话，直接取消，别让它的回复落到新对话里 */
    if (String((SETTINGS.chat && SETTINGS.chat.dshSessionId) || '') !== String(before)) resetChatPending();
    return sendJson(res, 200, await chatStatePayload());
  }
  if (p === '/api/chat/workspace/new') {
    return sendJson(res, 200, await createDshWorkspace());
  }
  if (p === '/api/generate-image') {
    return sendJson(res, 200, await generateImage(body));
  }
  if (p === '/api/tts/probe') {
    return sendJson(res, 200, await probeSoVits(body));
  }
  if (p === '/api/tts/start') {
    /* 用户主动点「启动」：无视 autoStart 开关，但只认显式配置的目录，且把实际路径回给界面 */
    const st = await ensureSoVits(true);
    securityLog('sovits.start', { path: (st && st.detected) || '', pid: (st && st.pid) || 0 });
    return sendJson(res, 200, sovitsStatus());
  }
  if (p === '/api/tts') {
    const out = await synthSpeech(body);
    res.writeHead(200, { 'Content-Type': out.type, 'Content-Length': out.buffer.length, 'Cache-Control': 'no-store' });
    return res.end(out.buffer);
  }
  return sendJson(res, 404, { ok: false, error: 'not found' });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + HOST);
  const p = url.pathname;
  const method = req.method || 'GET';
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');

  /* 跨站来源一律拒绝（见 localRequestGuard） */
  if (!localRequestGuard(req, res)) return;

  /* 第二层：本机也要令牌。挡的是同机其他账户、端口转发和盲目扫描，见 API_TOKEN 说明 */
  if (p.indexOf('/api/') === 0 && !tokenExempt(method, p) && !tokenMatches(requestToken(req, url))) {
    try { req.resume(); } catch (e) { /* 丢掉可能还在发的请求体 */ }
    sendJson(res, 401, {
      ok: false, needToken: true,
      error: '缺少或错误的访问令牌。桌面版会自动带上；源码方式启动请用控制台打印的带 token 地址打开页面。',
    });
    return;
  }

  if (method === 'POST' && p === '/api/pack/import') {
    const ct = String((req.headers || {})['content-type'] || '').toLowerCase();
    if (ct.indexOf('application/zip') < 0 && ct.indexOf('application/octet-stream') < 0) {
      sendJson(res, 415, { ok: false, error: '素材包请求类型不正确' });
      return;
    }
    readBinaryBody(req).then((buf) => sendJson(res, 200, importAssetPack(buf)))
      .catch((e) => sendError(res, e));
    return;
  }
  if (method === 'POST' && p.indexOf('/api/') === 0) {
    /* 写接口只接受 JSON，挡住表单 / text/plain 之类浏览器可跨站发出的类型 */
    const ct = String((req.headers || {})['content-type'] || '').toLowerCase();
    if (ct.indexOf('application/json') < 0) {
      sendJson(res, 415, { ok: false, error: '请求类型不正确（需要 application/json）' });
      return;
    }
    handlePost(p, req, res).catch((e) => sendError(res, e));
    return;
  }
  if (method !== 'GET' && method !== 'HEAD') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return; }

  if (p === '/' || p === '/index.html') {
    let html;
    try { html = fs.readFileSync(localPath('index.html')); }
    catch (e) { res.writeHead(500); res.end('index.html missing'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP });
    res.end(html);
    return;
  }
  if (p === '/api/health') {
    /* 桌面端探活用：只回答「端口上是不是千肥万鱼」，不泄漏任何本机路径 */
    sendJson(res, 200, { ok: true, app: 'fish-watch', version: APP_VERSION, port: PORT });
    return;
  }
  if (p === '/api/dsh/agent-state') {
    sendJson(res, 200, { ok: true, state: DSH_AGENT_STATE });
    return;
  }
  if (p === '/api/snapshot') {
    let body;
    try { body = JSON.stringify(snapshot()); }
    catch (e) { body = JSON.stringify({ error: e.message, readOnly: true }); }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Security-Policy': CSP });
    res.end(body);
    return;
  }
  if (p === '/api/assets') {
    sendJson(res, 200, assetsPayload());
    return;
  }
  if (p === '/api/pack/export') {
    /* 素材包导出：scope=mine 仅上传素材+配置，full 含全部图片/音频/UI */
    try {
      const scope = url.searchParams.get('scope') === 'full' ? 'full' : 'mine';
      const pack = buildAssetPack(scope);
      const day = dayKey(new Date());
      const fname = 'fishwatch-pack-' + scope + '-' + day + '.zip';
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Length': pack.buf.length,
        'Content-Disposition': 'attachment; filename="' + fname + '"; filename*=UTF-8\'\'' + encodeURIComponent(fname),
        'Content-Security-Policy': CSP,
      });
      res.end(pack.buf);
    } catch (e) { sendError(res, e); }
    return;
  }
  if (p === '/api/schedule/now') {
    /* 按来源返回此刻条目与场景/时段/立绘映射；DSH 文件只读，自有日程可生成/保存 */
    sendJson(res, 200, scheduleNow());
    return;
  }
  if (p === '/api/settings') {
    sendJson(res, 200, { ok: true, settings: publicSettings(SETTINGS) });
    return;
  }

  if (p === '/api/tts/status') {
    /* 本地语音引擎连接状态（供前端启动时自动探测与显示） */
    sendJson(res, 200, sovitsStatus());
    return;
  }
  if (p === '/api/audio/index') {
    /* 音频清单：BGM/环境音/音效与场景映射，静态文件从 /assets/audio/* 提供 */
    try {
      const j = JSON.parse(fs.readFileSync(localPath('assets/audio/index.json'), 'utf8'));
      sendJson(res, 200, Object.assign({ ok: true }, j));
    } catch (e) { sendJson(res, 200, { ok: false, bgm: {}, amb: {}, sfx: {} }); }
    return;
  }
  if (p === '/api/persona') {
    sendJson(res, 200, publicPersona(loadPersona()));
    return;
  }
  if (p === '/api/persona/dsh') {
    sendJson(res, 200, dshPersonaPayload(url.searchParams.get('id') || ''));
    return;
  }
  if (p === '/api/diary/list') {
    sendJson(res, 200, { ok: true, entries: diaryList() });
    return;
  }
  if (p === '/api/diary') {
    const day = url.searchParams.get('date') || '';
    if (!validDayKey(day)) { sendJson(res, 400, { ok: false, error: '日期格式应为 YYYY-MM-DD' }); return; }
    try {
      sendJson(res, 200, { ok: true, entry: JSON.parse(fs.readFileSync(diaryFile(day), 'utf8')) });
    } catch (e) { sendJson(res, 404, { ok: false, error: '这天还没有日记' }); }
    return;
  }
  if (p === '/api/chat/state') {
    chatStatePayload().then(function (out) { sendJson(res, 200, out); }).catch(function (e) { sendError(res, e); });
    return;
  }
  if (p === '/api/chat/log') {
    /* BACKLOG 用：返回完整本地对话历史（只读 chat-log.json，最多 240 条） */
    sendJson(res, 200, { ok: true, log: CHAT_LOG.slice() });
    return;
  }
  if (p.startsWith('/assets/')) {
    let name;
    try { name = decodeURIComponent(p.slice('/assets/'.length)); }
    catch (e) { res.writeHead(400); res.end('bad encoding'); return; }
    serveAsset(res, name);
    return;
  }
  if (p.startsWith('/media/')) {
    if (!loadAssets().useDshPetArt) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('DSH pet art is disabled');
      return;
    }
    serveMedia(req, res, p.slice('/media/'.length));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

server.on('error', (e) => {
  console.error('[fish-watch] 启动失败：' + e.message);
  console.error('可换端口：set FISH_WATCH_PORT=18766 后重新运行');
  process.exitCode = 1;
});

ensureLocalDirs();
const OPEN_URL = 'http://' + HOST + ':' + PORT + '/#fw_token=' + encodeURIComponent(API_TOKEN);
server.listen(PORT, HOST, () => {
  /* 仅当用户显式开启「自动启动」时才尝试拉起本地 GPT-SoVITS，不阻塞启动 */
  setTimeout(function () { ensureSoVits(false); }, 300);
  console.log('[fish-watch] 观察台已启动');
  console.log('  DSH 数据目录：' + ROOT + '  (只读；仅「保存到 DSH」时写回 surfcore 当前 persona.md)');
  console.log('  本地写入范围：' + APP_DIR + '\\settings.json、persona.json、assets.json、chat-log.json、assets\\uploads\\、data\\schedules\\、data\\diaries\\ 与 data\\persona-backups\\');
  console.log('  访问地址（带访问令牌，请用这个打开）：');
  console.log('    ' + OPEN_URL);
  console.log('  令牌文件：' + TOKEN_FILE + '（仅当前用户可读；删掉后下次启动会重新生成）');
  console.log('  对话：固定走 DSH 会话，经 .dsh/mobile-remote 口令（只读）');
  console.log('  语音：浏览器语音 / 服务端 TTS / 本地 GPT-SoVITS（默认 http://127.0.0.1:9880，默认不自动启动）');
  console.log('  按 Ctrl+C 停止。');
  if (process.env.FISH_WATCH_NO_OPEN !== '1' && process.platform === 'win32') {
    exec('start "" "' + OPEN_URL + '"', () => {});
  }
});

/* 桌面端（desktop/main.js）在进程内 require 本文件，直接从这里拿令牌注入页面地址，
 * 免去读文件、也避免主目录不可写时拿不到令牌。 */
module.exports = { token: API_TOKEN, port: PORT, host: HOST, url: OPEN_URL, tokenFile: TOKEN_FILE };
