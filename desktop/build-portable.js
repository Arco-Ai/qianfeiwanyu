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
const APP_PACK = path.join(OUT_DIR, 'resources', 'app');

/* 需要一起打包的程序文件（相对路径）。
 * 注意：settings.json 不在此列——它会由下面的出厂模板生成，避免把使用者的
 * 称呼 / API Key / DSH 口令等私人设置打进发行包。 */
const INCLUDE_FILES = [
  'package.json',
  'desktop/main.js',
  'desktop/preload.js',
  'server.js',
  'index.html',
  'assets.json',
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
    streaming: false, timeoutSec: 120,
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
  return bad;
}

function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
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

function main() {
  if (!fs.existsSync(ELECTRON_DIST)) {
    console.error('找不到 Electron 运行时，请先执行：npm install');
    process.exit(1);
  }
  console.log('清理旧的打包产物…');
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log('复制 Electron 运行时（约 350MB，稍等）…');
  copyDir(ELECTRON_DIST, OUT_DIR);
  /* resources 里的默认 default_app.asar 会被我们的 app 取代，删掉避免混淆 */
  const defApp = path.join(OUT_DIR, 'resources', 'default_app.asar');
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
  for (const dir of INCLUDE_DIRS) {
    copyDir(path.join(APP_DIR, dir), path.join(APP_PACK, dir), (name, srcPath) => {
      /* 运行数据目录整目录排除（data/、assets/uploads/） */
      const rel = relOf(srcPath);
      if (isRuntimePath(rel)) return true;
      /* 通用：打包时不带运行期产物与临时文件 */
      if (name === 'atri-expressions-pack.zip' || name.endsWith('.log') || name.startsWith('_')) return true;
      return false;
    });
  }
  /* 兜底：确保运行期会用到的空目录存在（server.js 也会自建，这里显式创建更稳妥） */
  for (const d of ['data/schedules', 'data/diaries', 'data/persona-backups', 'assets/uploads', 'assets/audio/bgm']) {
    fs.mkdirSync(path.join(APP_PACK, d), { recursive: true });
  }

  /* 隐私自检：任何运行数据 / 私人身份信息漏进发行包就中止打包 */
  const leaks = findRuntimeLeaks().concat(findPrivacyLeaks());
  if (leaks.length) {
    console.error('打包中止：以下私人数据可能进入了发行包');
    leaks.slice(0, 30).forEach((f) => console.error('  ' + f));
    if (leaks.length > 30) console.error('  …共 ' + leaks.length + ' 项');
    process.exit(1);
  }

  /* 重命名主程序 */
  const exeSrc = path.join(OUT_DIR, 'electron.exe');
  const exeDst = path.join(OUT_DIR, '千肥万鱼.exe');
  if (fs.existsSync(exeSrc)) fs.renameSync(exeSrc, exeDst);

  /* 附一份简单说明 */
  fs.writeFileSync(path.join(OUT_DIR, '使用说明.txt'),
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
  console.log('入口：' + exeDst);
}

main();
