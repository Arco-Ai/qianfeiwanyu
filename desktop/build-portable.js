'use strict';

/*
 * 打包成「免安装、免浏览器」的独立桌面程序。
 *
 * 产物：dist/千肥万鱼/千肥万鱼.exe
 *  - Electron 运行时 + 本程序（resources/app）打包在同一个文件夹里
 *  - 整个文件夹可以拷到任何 Windows 机器上直接双击运行，不需要装 Node、不需要浏览器
 *  - 设置、素材、日程都留在程序目录，换机器时一起带走即可
 *
 * 用法：node desktop/build-portable.js
 */

const fs = require('fs');
const path = require('path');

const APP_DIR = path.resolve(__dirname, '..');
const ELECTRON_DIST = path.join(APP_DIR, 'node_modules', 'electron', 'dist');
const OUT_ROOT = path.join(APP_DIR, 'dist');
const OUT_DIR = path.join(OUT_ROOT, '千肥万鱼');
/* 先在同级的暂存目录里完整构建，成功后再替换 OUT_DIR：
 * 这样既不会在构建中途删掉上一版（及其中的用户数据），
 * 也能在最后一步识别旧版是否被正在运行的 exe 占用。 */
const STAGE_DIR = path.join(OUT_ROOT, '千肥万鱼.building');
const APP_PACK = path.join(STAGE_DIR, 'resources', 'app');

/* 需要一起打包的程序文件（相对路径）。
 * 注意：settings.json 不在此列——它会由下面的出厂模板生成，避免把使用者的
 * 称呼 / API Key / DSH 口令等私人设置打进发行包。 */
const INCLUDE_FILES = [
  'package.json',
  'desktop/main.js',
  'desktop/preload.js',
  'server.js',
  'index.html',
  'scenes.json',
  'fish-watch.config.yml',
  'start.cmd',
];
/* 素材目录。注意 data/ 不在这里：整个目录都是使用者的运行数据（日记、日程、
 * 人格备份、素材包备份），只按扩展名挑文件会漏掉人格备份的 .md / .txt，
 * 所以整目录不复制，改由 main() 末尾创建空目录骨架。 */
const INCLUDE_DIRS = ['assets'];

/* 这些目录属于运行时数据，打包时整目录跳过，绝不依赖扩展名清单 */
const RUNTIME_DIRS = ['data', 'assets/uploads'];

/* 出厂设置模板：与 server.js 的 DEFAULT_SETTINGS 保持一致，所有个人信息留空。
 * 首次运行时程序会据此创建干净的 settings.json，不会带出打包者的数据。 */
const FACTORY_SETTINGS = {
  petName: '', characterName: '', ownerName: '', chatName: '', portrait: '',
  tts: { enabled: false, autoRead: false, stripActions: true, engine: 'browser', voice: '', rate: 1, pitch: 1, volume: 1 },
  image: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-image-1', size: '1024x1024', responseFormat: 'b64_json' },
  serverTts: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'tts-1', voice: 'alloy', format: 'mp3' },
  sovits: {
    baseUrl: 'http://127.0.0.1:9880', refAudioPath: '', promptText: '', promptLang: 'zh', textLang: 'zh',
    speed: 1, topK: 5, topP: 1, temperature: 1, splitMethod: 'cut5', batchSize: 1, mediaType: 'wav',
    streaming: false, timeoutSec: 120, autoStart: false,
  },
  chat: { dshBaseUrl: 'http://127.0.0.1:3080/m/api', dshSessionId: '', dshToken: '', replyTimeoutSec: 100 },
  schedule: { enabled: true, driveScene: true, driveSlot: true, drivePortrait: true, source: 'auto', autoGenerate: true },
  diary: { enabled: true, time: '21:00', maxDays: 180 },
};

/* data/ 整目录都不打包；这里不再按扩展名逐项排除（那会漏掉 .md / .txt 人格备份） */

/* ---------- 运行数据目录的整目录排除 ---------- */
function relOf(p) { return path.relative(APP_DIR, p).replace(/\\/g, '/'); }
function isRuntimePath(rel) {
  return RUNTIME_DIRS.some((d) => rel === d || rel.indexOf(d + '/') === 0);
}

/* 打包后自检：运行数据目录里除 .gitkeep 外不该有任何文件。
 * 过滤规则一旦被绕过（新增备份格式、改名、新目录），这里会直接失败，
 * 而不是把使用者的私人文本带进发行包。 */
function findRuntimeLeaks() {
  const leaked = [];
  for (const d of RUNTIME_DIRS) {
    const root = path.join(APP_PACK, d);
    if (!fs.existsSync(root)) continue;
    (function walk(p) {
      for (const n of fs.readdirSync(p)) {
        const f = path.join(p, n);
        const st = fs.statSync(f);
        if (st.isDirectory()) walk(f);
        else if (n !== '.gitkeep') leaked.push(relOf(f));
      }
    })(root);
  }
  return leaked;
}

/* 自检身份信息：确认出厂设置与空聊天记录真的干净 */
function findPrivacyLeaks() {
  const bad = [];
  const idFields = ['petName', 'characterName', 'ownerName', 'chatName', 'portrait'];
  try {
    const s = JSON.parse(fs.readFileSync(path.join(APP_PACK, 'settings.json'), 'utf8'));
    for (const k of idFields) if (String(s[k] == null ? '' : s[k]).trim()) bad.push('settings.json:' + k);
  } catch (e) { bad.push('settings.json 无法解析'); }
  try {
    const log = JSON.parse(fs.readFileSync(path.join(APP_PACK, 'chat-log.json'), 'utf8'));
    if (!Array.isArray(log) || log.length) bad.push('chat-log.json 非空');
  } catch (e) { bad.push('chat-log.json 无法解析'); }
  for (const f of ['persona.json', 'window-state.json', 'settings.local.json']) {
    if (fs.existsSync(path.join(APP_PACK, f))) bad.push(f);
  }
  /* 用户上传的 BGM 不能以任何形式留在包内 */
  for (const f of listFiles(path.join(APP_PACK, 'assets/audio'))) {
    if (path.basename(f).indexOf('upload_') === 0) bad.push(relOf(f));
  }
  return bad;
}

function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

/* ---------- 旧版使用数据识别 ----------
 * dist/千肥万鱼 本身也是便携版的数据目录：用户运行过后，聊天、日记、日程、
 * 上传素材都存在里面。重新打包时不能直接删掉整目录，必须先把这一版整体留档。
 */
function listFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  (function walk(p) {
    for (const n of fs.readdirSync(p)) {
      const f = path.join(p, n);
      let st;
      try { st = fs.statSync(f); } catch (e) { continue; }
      if (st.isDirectory()) walk(f);
      else out.push(f);
    }
  })(dir);
  return out;
}
/* 顺序无关的 JSON 比较：判断配置是否还等于出厂值 */
function stableJson(v) {
  if (v && typeof v === 'object') {
    if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableJson(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}
function oldBuildHasUserData(outDir) {
  const app = path.join(outDir, 'resources', 'app');
  if (!fs.existsSync(app)) return false;
  /* data/ 与 uploads/ 里只要不是占位文件，就说明被用过 */
  for (const d of ['data', 'assets/uploads']) {
    const files = listFiles(path.join(app, d)).filter((f) => path.basename(f) !== '.gitkeep');
    if (files.length) return true;
  }
  /* 用户上传的 BGM 也在运行目录里 */
  if (listFiles(path.join(app, 'assets/audio/bgm')).some((f) => path.basename(f).indexOf('upload_') === 0)) return true;
  /* 设置 / 素材配置 / 曲目索引只要不再等于出厂值，就视为用户配置：
   * 只改过 DSH 地址、API Key 或立绘，也必须留档，不能删。 */
  try {
    const s = JSON.parse(fs.readFileSync(path.join(app, 'settings.json'), 'utf8'));
    if (stableJson(s) !== stableJson(FACTORY_SETTINGS)) return true;
  } catch (e) { return true; }   /* 读不动的设置文件也按用户数据处理 */
  try {
    const a = JSON.parse(fs.readFileSync(path.join(app, 'assets.json'), 'utf8'));
    if (stableJson(a) !== stableJson(sanitizeAssetsConfig())) return true;
  } catch (e) { /* 旧版没有 assets.json 不算 */ }
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(app, 'assets/audio/index.json'), 'utf8'));
    const clean = sanitizeAudioIndex();
    if (clean && stableJson(idx) !== stableJson(clean)) return true;
  } catch (e) { /* 忽略 */ }
  for (const f of ['persona.json', 'window-state.json']) {
    if (fs.existsSync(path.join(app, f))) return true;
  }
  return false;
}

/* ---------- 素材配置脱敏 ----------
 * 不能直接复制打包者当前的 assets.json：它可能已经指向自选立绘 / 背景、
 * 或 assets/audio/bgm/upload_* 这类不会进发行包的文件。这里逐槽位检查，
 * 指向不存在或属于上传目录的值一律清空，场景自定义也退回默认场景库。
 */
function assetFileExists(rel) {
  const p = path.join(APP_DIR, 'assets', String(rel || ''));
  try { return fs.statSync(p).isFile(); } catch (e) { return false; }
}
function sanitizeAssetsConfig() {
  const src = path.join(APP_DIR, 'assets.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(src, 'utf8')); } catch (e) { cfg = {}; }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) cfg = {};
  for (const group of ['background', 'portrait', 'portrait2', 'ui', 'audio']) {
    const g = cfg[group];
    if (!g || typeof g !== 'object' || Array.isArray(g)) continue;
    for (const key of Object.keys(g)) {
      const v = g[key];
      if (typeof v !== 'string' || !v) continue;
      if (v.indexOf('uploads/') === 0 || v.indexOf('upload_') >= 0 || !assetFileExists(v)) g[key] = '';
    }
  }
  if (typeof cfg.whaleWallpaper === 'string' && cfg.whaleWallpaper
    && (cfg.whaleWallpaper.indexOf('uploads/') === 0 || !assetFileExists(cfg.whaleWallpaper))) cfg.whaleWallpaper = '';
  /* 形态目录不存在时回落到默认形态，避免引用发行包里没有的立绘 */
  if (cfg.form && !fs.existsSync(path.join(APP_DIR, 'assets', String(cfg.form)))) cfg.form = 'whale-mature';
  /* 自定义场景依赖 background 三张图；这些图被清空后继续 pin=custom 会显示空白 */
  if (cfg.scenes && typeof cfg.scenes === 'object' && cfg.scenes.pin === 'custom') cfg.scenes.pin = 'home';
  return cfg;
}
/* 曲目索引同样要清理：custom 列表和任何 upload_* 都指向不会进包的文件 */
function sanitizeAudioIndex() {
  const src = path.join(APP_DIR, 'assets/audio/index.json');
  let j;
  try { j = JSON.parse(fs.readFileSync(src, 'utf8')); } catch (e) { return null; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  for (const group of ['bgm', 'amb', 'sfx']) {
    const g = j[group];
    if (!g || typeof g !== 'object' || Array.isArray(g)) continue;
    for (const key of Object.keys(g)) {
      if (key === 'custom') { g.custom = []; continue; }
      if (!Array.isArray(g[key])) continue;
      g[key] = g[key].filter((rel) => String(rel).indexOf('upload_') < 0 && assetFileExists(rel));
    }
  }
  return j;
}

/* ---------- 打包后自检：发行配置不能引用包外文件 ---------- */
function findAssetRefProblems() {
  const bad = [];
  const packAsset = (rel) => {
    try { return fs.statSync(path.join(APP_PACK, 'assets', String(rel || ''))).isFile(); } catch (e) { return false; }
  };
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(APP_PACK, 'assets.json'), 'utf8'));
    for (const group of ['background', 'portrait', 'portrait2', 'ui', 'audio']) {
      const g = cfg[group];
      if (!g || typeof g !== 'object') continue;
      for (const key of Object.keys(g)) {
        const v = g[key];
        if (typeof v === 'string' && v && (!packAsset(v) || v.indexOf('uploads/') === 0 || v.indexOf('upload_') >= 0)) bad.push('assets.json:' + group + '.' + key + ' → ' + v);
      }
    }
    if (typeof cfg.whaleWallpaper === 'string' && cfg.whaleWallpaper && !packAsset(cfg.whaleWallpaper)) bad.push('assets.json:whaleWallpaper → ' + cfg.whaleWallpaper);
  } catch (e) { bad.push('assets.json 无法解析'); }
  try {
    const j = JSON.parse(fs.readFileSync(path.join(APP_PACK, 'assets/audio/index.json'), 'utf8'));
    for (const group of ['bgm', 'amb', 'sfx']) {
      const g = j[group];
      if (!g || typeof g !== 'object') continue;
      for (const key of Object.keys(g)) {
        if (key === 'custom' && Array.isArray(g.custom) && g.custom.length) bad.push('audio/index.json:custom 非空');
        if (!Array.isArray(g[key])) continue;
        for (const rel of g[key]) {
          if (String(rel).indexOf('upload_') >= 0 || !packAsset(rel)) bad.push('audio/index.json:' + group + '.' + key + ' → ' + rel);
        }
      }
    }
  } catch (e) { bad.push('audio/index.json 无法解析'); }
  return bad;
}

function copyDir(src, dst, skip) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    if (skip && skip(name, s)) continue;
    const d = path.join(dst, name);
    const st = fs.statSync(s);
    if (st.isDirectory()) copyDir(s, d, skip);
    else fs.copyFileSync(s, d);
  }
}

function stampNow() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}
/* 用暂存目录替换正式目录。旧版如果被运行过，整个目录（含使用数据）改名留档，
 * 绝不删除；只有确认是纯构建产物时才直接删。 */
function finalizeBuild() {
  if (fs.existsSync(OUT_DIR)) {
    if (oldBuildHasUserData(OUT_DIR)) {
      const bak = path.join(OUT_ROOT, '千肥万鱼-备份-' + stampNow());
      try {
        fs.renameSync(OUT_DIR, bak);
      } catch (e) {
        console.error('旧版目录正在被占用（可能 exe 还开着），没有替换任何文件。');
        console.error('请关闭正在运行的千肥万鱼后重新打包；旧数据仍在：' + OUT_DIR);
        console.error('本次构建保留在暂存目录：' + STAGE_DIR);
        return false;
      }
      console.log('旧版含有使用数据，已整体备份到：' + bak);
    } else {
      fs.rmSync(OUT_DIR, { recursive: true, force: true });
    }
  }
  try {
    fs.renameSync(STAGE_DIR, OUT_DIR);
  } catch (e) {
    console.error('替换发行目录失败：' + e.message);
    return false;
  }
  return true;
}

function main() {
  if (!fs.existsSync(ELECTRON_DIST)) {
    console.error('找不到 Electron 运行时，请先执行：npm install');
    process.exit(1);
  }
  console.log('准备暂存目录（不会改动现有 dist/千肥万鱼）…');
  fs.rmSync(STAGE_DIR, { recursive: true, force: true });
  fs.mkdirSync(STAGE_DIR, { recursive: true });

  console.log('复制 Electron 运行时（约 350MB，稍等）…');
  copyDir(ELECTRON_DIST, STAGE_DIR);
  /* resources 里的默认 default_app.asar 会被我们的 app 取代，删掉避免混淆 */
  const defApp = path.join(STAGE_DIR, 'resources', 'default_app.asar');
  if (fs.existsSync(defApp)) fs.rmSync(defApp);

  console.log('复制程序文件…');
  for (const rel of INCLUDE_FILES) {
    const s = path.join(APP_DIR, rel);
    if (fs.existsSync(s)) copyFile(s, path.join(APP_PACK, rel));
  }
  /* 写入干净的出厂设置，而不是复制打包者当前使用的 settings.json */
  fs.writeFileSync(path.join(APP_PACK, 'settings.json'), JSON.stringify(FACTORY_SETTINGS, null, 2) + '\n', 'utf8');
  /* chat-log 出厂为空，绝不带出打包者的聊天记录 */
  fs.writeFileSync(path.join(APP_PACK, 'chat-log.json'), '[]\n', 'utf8');
  /* assets.json 不直接复制：清掉指向上传素材或不存在文件的槽位 */
  fs.writeFileSync(path.join(APP_PACK, 'assets.json'), JSON.stringify(sanitizeAssetsConfig(), null, 2) + '\n', 'utf8');
  for (const dir of INCLUDE_DIRS) {
    copyDir(path.join(APP_DIR, dir), path.join(APP_PACK, dir), (name, srcPath) => {
      /* 运行数据目录整目录排除（data/、assets/uploads/） */
      const rel = relOf(srcPath);
      if (isRuntimePath(rel)) return true;
      /* 用户上传的 BGM 属于私人素材：排除文件本身，索引稍后统一清理 */
      if (rel.indexOf('assets/audio/') === 0 && name.indexOf('upload_') === 0) return true;
      /* 通用：打包时不带运行期产物与临时文件 */
      if (name === 'atri-expressions-pack.zip' || name.endsWith('.log') || name.startsWith('_')) return true;
      return false;
    });
  }
  /* 曲目索引里去掉 custom 与指向 upload_* 的条目，避免发行包引用不存在的音频 */
  const cleanIdx = sanitizeAudioIndex();
  if (cleanIdx) fs.writeFileSync(path.join(APP_PACK, 'assets/audio/index.json'), JSON.stringify(cleanIdx, null, 2) + '\n', 'utf8');
  /* 兜底：确保运行期会用到的空目录存在（server.js 也会自建，这里显式创建更稳妥） */
  for (const d of ['data/schedules', 'data/diaries', 'data/persona-backups', 'assets/uploads', 'assets/audio/bgm']) {
    fs.mkdirSync(path.join(APP_PACK, d), { recursive: true });
  }

  /* 隐私自检：任何运行数据 / 私人身份信息漏进发行包就中止打包 */
  const leaks = findRuntimeLeaks().concat(findPrivacyLeaks(), findAssetRefProblems());
  if (leaks.length) {
    console.error('打包中止：以下私人数据或失效引用会进入发行包');
    leaks.slice(0, 30).forEach((f) => console.error('  ' + f));
    if (leaks.length > 30) console.error('  …共 ' + leaks.length + ' 项');
    process.exit(1);
  }

  /* 重命名主程序 */
  const exeSrc = path.join(STAGE_DIR, 'electron.exe');
  const exeDst = path.join(STAGE_DIR, '千肥万鱼.exe');
  if (fs.existsSync(exeSrc)) fs.renameSync(exeSrc, exeDst);

  /* 附一份简单说明 */
  fs.writeFileSync(path.join(STAGE_DIR, '使用说明.txt'),
    '千肥万鱼 · 独立桌面版\r\n'
    + '============================\r\n\r\n'
    + '1. 双击「千肥万鱼.exe」即可打开，不需要安装 Node.js，也不经过浏览器。\r\n'
    + '2. 整个文件夹可以拷到别的 Windows 电脑直接用；设置、素材、日程都在文件夹里。\r\n'
    + '3. 连别的电脑上的 DSH：打开 设置 → 对话，把「DSH 地址」改成那台机器\r\n'
    + '   的移动桥地址（例如 http://192.168.1.20:3080/m/api），口令填该机器的\r\n'
    + '   mobile-remote token，然后点「测试连接」。\r\n'
    + '4. 本地语音（GPT-SoVITS）是可选项：没装也能正常聊天，只是不朗读。\r\n'
    + '   装了的话会自动探测常见安装位置，也可以用环境变量 FISH_SOVITS_DIR 指定。\r\n'
    + '5. 数据目录默认是 %USERPROFILE%\\.dsh；DSH 装在别处时用环境变量 DSH_ROOT 指定。\r\n', 'utf8');

  if (!finalizeBuild()) process.exit(1);

  /* 统计体积 */
  let bytes = 0;
  (function walk(p) {
    for (const n of fs.readdirSync(p)) {
      const f = path.join(p, n);
      const st = fs.statSync(f);
      if (st.isDirectory()) walk(f); else bytes += st.size;
    }
  })(OUT_DIR);
  console.log('完成：' + OUT_DIR);
  console.log('体积：' + (bytes / 1024 / 1024).toFixed(0) + ' MB');
  console.log('入口：' + path.join(OUT_DIR, '千肥万鱼.exe'));
}

main();
