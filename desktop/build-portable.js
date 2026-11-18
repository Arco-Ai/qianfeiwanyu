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

/* 需要一起打包的程序文件（相对路径） */
const INCLUDE_FILES = [
  'package.json',
  'desktop/main.js',
  'desktop/preload.js',
  'server.js',
  'index.html',
  'settings.json',
  'assets.json',
  'scenes.json',
  'fish-watch.config.yml',
  'start.cmd',
];
const INCLUDE_DIRS = ['assets', 'data'];

function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function copyDir(src, dst, skip) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (skip && skip(name)) continue;
    const s = path.join(src, name);
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
  for (const dir of INCLUDE_DIRS) {
    copyDir(path.join(APP_DIR, dir), path.join(APP_PACK, dir), (name) =>
      /* 打包时不带运行期产物与临时文件 */
      name === 'atri-expressions-pack.zip' || name.endsWith('.log') || name.startsWith('_'));
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
