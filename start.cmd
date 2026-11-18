@echo off
chcp 65001 >nul 2>nul
cd /d "%~dp0"

echo ============================================================
echo  千肥万鱼 · 浏览器模式
echo ============================================================
echo  这个脚本用本机 Node 起服务，再用系统浏览器打开页面。
echo  想要独立窗口（不经过浏览器），请直接双击「千肥万鱼.exe」。
echo.
echo  数据目录：%USERPROFILE%\.dsh（只读，可用 DSH_ROOT 覆盖）
echo  写入范围：本文件夹内的 settings.json / assets.json / data / assets\uploads
echo  可选环境变量：
echo    FISH_WATCH_PORT   换端口，默认 18765
echo    DSH_ROOT          DSH 数据目录，默认 %USERPROFILE%\.dsh
echo    FISH_SOVITS_DIR   GPT-SoVITS 安装目录（观察台默认不自动启动，需要时在设置里点「启动」）
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没找到 Node.js。
  echo.
  echo 想免安装 Node 运行，请改用同目录下的「千肥万鱼.exe」。
  echo 或者安装 Node.js 18 及以上版本后重试。
  echo.
  pause
  exit /b 1
)

echo 正在启动本地服务...
node server.js
echo.
echo 服务已停止。
pause
