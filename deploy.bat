@echo off
chcp 65001 >nul 2>&1
echo ============================================
echo  My Workbench - Deploy to GitHub Pages
echo ============================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1"
echo.
echo Press any key to close...
pause >nul
