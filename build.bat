@echo off
setlocal
cd /d "%~dp0"
if not exist dist mkdir dist

echo [1/2] test
call em++ -std=c++17 -Wall test\test.cpp src\ProtoShadeRuntime.cpp -o dist\test.js || exit /b 1
node dist\test.js || exit /b 1

echo [2/2] wasm library
call em++ -std=c++17 -O2 src\ProtoShadeRuntime.cpp wasm\bindings.cpp -lembind -sMODULARIZE -sEXPORT_ES6 -o dist\protoshade.js || exit /b 1
echo done: dist\protoshade.js + dist\protoshade.wasm
