@echo off
chcp 65001 >nul
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Python 3.10 或更新版本，并添加到 PATH。
  pause
  exit /b 1
)
echo 转个弯正在启动：http://127.0.0.1:8765
echo 关闭本窗口即可结束本次服务。
python app.py --port 8765 --open-browser
pause
