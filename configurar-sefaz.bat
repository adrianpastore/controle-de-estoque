@echo off
title Configurar certificado (SEFAZ)
cd /d "%~dp0"
chcp 65001 >nul
node scripts\configurar-sefaz.js
echo.
pause
