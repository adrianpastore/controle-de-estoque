@echo off
title Controle de Estoque
cd /d "%~dp0"
echo Iniciando o Controle de Estoque... (feche esta janela para desligar)
echo.
node src\server.js
pause
