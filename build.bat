@echo off
setlocal
cd /d "%~dp0"
if not exist dist mkdir dist

echo [1/2] test
rem Emscripten's node glue is CommonJS, and package.json says "type": "module", so node
rem refuses a .js file that calls require(). Rename it to .cjs instead of fighting either
rem side - the .wasm next to it is still found by name, and emcc does not accept .cjs itself.
call em++ -std=c++17 -Wall test\test.cpp src\ProtoShadeRuntime.cpp -o dist\test.js || exit /b 1
move /y dist\test.js dist\test.cjs >nul || exit /b 1
node dist\test.cjs || exit /b 1

echo [2/2] wasm library
call em++ -std=c++17 -O2 src\ProtoShadeRuntime.cpp wasm\bindings.cpp -lembind -sMODULARIZE -sEXPORT_ES6 -o dist\protoshade.js || exit /b 1
echo done: dist\protoshade.js + dist\protoshade.wasm
