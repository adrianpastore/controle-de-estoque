@echo off
title Controle de Estoque
cd /d "%~dp0"
chcp 65001 >nul
rem Prepara o que mudou (bibliotecas, ganchos do git) e mostra a situação do certificado.
node scripts\atualizar.js
:inicio
echo.
echo Iniciando o Controle de Estoque... (feche esta janela para desligar)
echo.
node src\server.js
rem O servidor parou (ex.: reiniciado depois de um git pull): sobe de novo, já com a versão nova.
echo.
echo O servidor parou. Ligando de novo em 3 segundos... (feche esta janela para desligar de vez)
timeout /t 3 /nobreak >nul
goto inicio
