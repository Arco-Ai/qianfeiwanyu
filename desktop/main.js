'use strict';

/*
 * 千肥万鱼 · 桌面端入口
 *
 * 设计要点：
 *  - 服务端（server.js）在主进程内启动，只监听 127.0.0.1，窗口直接加载本地页面，
 *    不经过任何外部浏览器，也不依赖系统默认浏览器。
 *  - 端口被占用时：先探测是不是本程序（/api/health），是就直接复用；不是则自动换端口。
 *  - 所有路径都相对程序目录解析（__dirname），换电脑/换盘符都能直接跑。
 *  - 程序目录必须可写（设置、素材、日程都写在程序目录里）；不可写时明确报错而不是静默失败。
 */

const { app, BrowserWindow, Menu, dialog, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const APP_DIR = path.resolve(__dirname, '..');
const IS_WIN = process.platform === 'win32';
const ICON_PATH = path.join(APP_DIR, 'assets', 'ui', 'app.ico');
const PRELOAD_PATH = path.join(__dirname, 'preload.js');
const WIN_STATE_PATH = path.join(APP_DIR, 'window-state.json');
const DEFAULT_PORT = Number(process.env.FISH_WATCH_PORT || 18765);
/* 与 server.js 保持一致：令牌存用户主目录，页面地址用 #fw_token= 带上（fragment 不会发给服务端） */
const TOKEN_FILE = path.join(os.homedir(), '.fish-watch', 'api-token');

let win = null;
let baseUrl = '';
let startUrl = '';
let serverMod = null;
let quitting = false;
let serverStarted = false;
let serverError = '';

/* ---------- 工具 ---------- */

function probe(port, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs || 900 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (body.length < 4096) body += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          resolve(j && j.app === 'fish-watch' ? j : null);
        } catch (e) { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = require('net').createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function waitServer(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = await probe(port, 700);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

function startServer(port) {
  process.env.FISH_WATCH_NO_OPEN = '1';
  process.env.FISH_WATCH_PORT = String(port);
  try {
    serverMod = require(path.join(APP_DIR, 'server.js')) || null;
    serverStarted = true;
    return true;
  } catch (e) {
    serverError = (e && e.stack) || String(e);
    return false;
  }
}

/* ---------- 启动流程 ---------- */

async function boot() {
  /* 程序目录必须可写：设置、上传素材、日程、日记都落在程序目录 */
  try {
    fs.accessSync(APP_DIR, fs.constants.W_OK);
  } catch (e) {
    dialog.showErrorBox('千肥万鱼无法启动',
      '程序目录不可写：\n' + APP_DIR +
      '\n\n请把整个文件夹移动到可写位置（例如桌面或 D 盘）后再打开。');
    app.quit();
    return;
  }

  let port = DEFAULT_PORT;
  let existing = await probe(port);

  if (!existing) {
    /* 端口被别的程序占用 → 自动向后找一个空闲端口 */
    if (!(await portFree(port))) {
      let found = 0;
      for (let p = port + 1; p < port + 40; p++) {
        if (await portFree(p)) { found = p; break; }
      }
      if (!found) {
        dialog.showErrorBox('千肥万鱼无法启动', '端口 ' + port + ' 被占用，且附近找不到可用端口。\n请关闭占用程序后重试。');
        app.quit();
        return;
      }
      port = found;
    }
    if (!startServer(port)) {
      dialog.showErrorBox('千肥万鱼启动失败', '本地服务没能启动：\n\n' + serverError.slice(0, 1200));
      app.quit();
      return;
    }
    existing = await waitServer(port, 20000);
    if (!existing) {
      dialog.showErrorBox('千肥万鱼启动超时', '本地服务在 20 秒内没有就绪。\n\n端口：' + port + '\n\n请检查是否有安全软件拦截 127.0.0.1 本地端口。');
      app.quit();
      return;
    }
  }

  baseUrl = 'http://127.0.0.1:' + port + '/';
  /* 令牌：优先用本进程启动服务时拿到的；复用已在运行的实例时读令牌文件 */
  let token = (serverMod && serverMod.token) || '';
  if (!token) {
    try { token = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (e) { token = ''; }
  }
  if (!/^[A-Za-z0-9_-]{20,}$/.test(token)) token = '';
  startUrl = token ? baseUrl + '#fw_token=' + encodeURIComponent(token) : baseUrl;
  createWindow();
}

/* ---------- 窗口状态持久化（分辨率 / 全屏） ---------- */

function readWinState() {
  try {
    const s = JSON.parse(fs.readFileSync(WIN_STATE_PATH, 'utf8'));
    if (s && typeof s === 'object') return s;
  } catch (e) { /* 首次运行或文件损坏 */ }
  return {};
}

function saveWinState(patch) {
  const s = Object.assign(readWinState(), patch || {});
  try { fs.writeFileSync(WIN_STATE_PATH, JSON.stringify(s), 'utf8'); } catch (e) { /* 只读目录则跳过持久化 */ }
  return s;
}

/* 通知渲染端窗口状态变化（手动拖拽缩放、按 F11 等） */
function pushWinState() {
  if (!win || win.isDestroyed()) return;
  let w = 0, h = 0, fullscreen = false;
  try {
    const b = win.getBounds(); w = b.width; h = b.height;
    fullscreen = !!win.isFullScreen();
  } catch (e) { return; }
  try { win.webContents.send('fw:win-state-changed', { width: w, height: h, fullscreen: fullscreen }); } catch (e) { /* 页面未就绪 */ }
  saveWinState({ width: w, height: h, fullscreen: fullscreen });
}

/* ---------- 窗口 ---------- */

function createWindow() {
  const saved = readWinState();
  const initW = Math.max(1024, Number(saved.width) || 1440);
  const initH = Math.max(700, Number(saved.height) || 900);
  win = new BrowserWindow({
    width: initW,
    height: initH,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#0b1a28',
    title: '千肥万鱼',
    icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      preload: fs.existsSync(PRELOAD_PATH) ? PRELOAD_PATH : undefined,
    },
  });

  win.once('ready-to-show', () => {
    win.show();
    if (saved.fullscreen) { try { win.setFullScreen(true); } catch (e) { /* 忽略 */ } }
    pushWinState();
  });
  win.loadURL(startUrl || baseUrl);

  /* 用户手动拖拽缩放 / F11 全屏后，同步状态给页面并落盘 */
  win.on('resize', () => { clearTimeout(win._fwResizeTimer); win._fwResizeTimer = setTimeout(pushWinState, 200); });
  win.on('enter-full-screen', pushWinState);
  win.on('leave-full-screen', pushWinState);

  /* 站内跳转留在窗口里，外链交给系统浏览器 */
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !url.startsWith(baseUrl)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(baseUrl)) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  /* 渲染进程异常时自动重载一次，避免白屏 */
  win.webContents.on('render-process-gone', () => {
    if (quitting) return;
    /* 用带令牌的地址重载：崩溃后 sessionStorage 可能已丢，裸地址会弹令牌框 */
    setTimeout(() => { if (win && !win.isDestroyed()) win.loadURL(startUrl || baseUrl); }, 800);
  });

  win.on('closed', () => { win = null; });
}

/* ---------- 菜单（保留复制/粘贴/刷新/缩放等常用操作） ---------- */

function buildMenu() {
  const template = [
    {
      label: '千肥万鱼',
      submenu: [
        { label: '重新载入', accelerator: 'F5', click: () => win && win.reload() },
        { label: '强制重载', accelerator: 'CmdOrCtrl+Shift+R', click: () => win && win.webContents.reloadIgnoringCache() },
        { type: 'separator' },
        { label: '打开程序目录', click: () => shell.openPath(APP_DIR) },
        { label: '开发者工具', accelerator: 'F12', click: () => win && win.webContents.toggleDevTools() },
        { type: 'separator' },
        { label: '退出', role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '实际大小', role: 'resetZoom' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于千肥万鱼',
          click: () => {
            dialog.showMessageBox(win, {
              type: 'info',
              title: '关于千肥万鱼',
              message: '千肥万鱼',
              detail: '千肥万鱼 · 桌面观察台\n\n本地服务：' + baseUrl + '\n程序目录：' + APP_DIR,
              buttons: ['好'],
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------- 窗口控制 IPC（供设置面板调用） ---------- */

ipcMain.handle('fw:win-state', () => {
  if (!win || win.isDestroyed()) return { width: 0, height: 0, fullscreen: false };
  try {
    const b = win.getBounds();
    return { width: b.width, height: b.height, fullscreen: !!win.isFullScreen() };
  } catch (e) { return { width: 0, height: 0, fullscreen: false }; }
});

ipcMain.handle('fw:win-size', (_e, w, h) => {
  if (!win || win.isDestroyed()) return { ok: false };
  w = Math.max(1024, Math.min(7680, Math.round(Number(w) || 0)));
  h = Math.max(700, Math.min(4320, Math.round(Number(h) || 0)));
  if (!w || !h) return { ok: false };
  try {
    if (win.isFullScreen()) win.setFullScreen(false);
    win.setSize(w, h);
    win.center();
    if (win.isMinimized()) win.restore();
    win.focus();
  } catch (e) { return { ok: false, error: String(e) }; }
  const b = win.getBounds();
  const state = { width: b.width, height: b.height, fullscreen: false };
  saveWinState(state);
  try { win.webContents.send('fw:win-state-changed', state); } catch (e) { /* 忽略 */ }
  return state;
});

ipcMain.handle('fw:win-fullscreen', (_e, on) => {
  if (!win || win.isDestroyed()) return { ok: false };
  try { win.setFullScreen(!!on); } catch (e) { return { ok: false, error: String(e) }; }
  const state = { fullscreen: !!win.isFullScreen() };
  saveWinState(state);
  try {
    const b = win.getBounds();
    win.webContents.send('fw:win-state-changed', { width: b.width, height: b.height, fullscreen: state.fullscreen });
  } catch (e) { /* 忽略 */ }
  return { ok: true, fullscreen: state.fullscreen };
});

/* ---------- 生命周期 ---------- */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    if (IS_WIN) app.setAppUserModelId('com.fishwatch.app');
    buildMenu();
    boot();
  });

  app.on('window-all-closed', () => {
    quitting = true;
    app.quit();
  });

  app.on('before-quit', () => { quitting = true; });

  /* 主进程兜底：别让单个异常直接黑掉窗口 */
  process.on('uncaughtException', (e) => {
    console.error('[fish-watch] 未捕获异常：', (e && e.stack) || e);
  });
}
