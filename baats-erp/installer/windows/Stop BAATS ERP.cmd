@echo off
title Stopping BAATS Enterprise ERP
"%~dp0node\node.exe" "%~dp0launcher\launcher.mjs" --stop
timeout /t 3 >nul
