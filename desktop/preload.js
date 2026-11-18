'use strict';

/*
 * 千肥万鱼 · 渲染进程桥
 *
 * 只暴露窗口控制的白名单 API 给页面（contextIsolation 下用 contextBridge）。
 * 页面用 window.fwWin.* 调用；浏览器直接打开 index.html 时此对象不存在，
 * 前端会自动降级并提示「仅 exe 客户端可用」。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fwWin', {
  isDesktop: true,

  /* 当前窗口状态：{width,height,fullscreen} */
  getState() {
    return ipcRenderer.invoke('fw:win-state');
  },

  /* 设定窗口内容尺寸（像素）；会自动退出全屏 */
  setSize(w, h) {
    return ipcRenderer.invoke('fw:win-size', Number(w), Number(h));
  },

  /* 进入 / 退出全屏；返回最新状态 */
  setFullscreen(on) {
    return ipcRenderer.invoke('fw:win-fullscreen', !!on);
  },

  /* 主进程窗口状态变化时回调（手动拖拽缩放、按 F11 等） */
  onState(cb) {
    if (typeof cb !== 'function') return;
    ipcRenderer.on('fw:win-state-changed', (_e, state) => {
      try { cb(state); } catch (err) { /* 忽略渲染端异常 */ }
    });
  },
});
