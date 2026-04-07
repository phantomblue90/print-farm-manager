@echo off
echo Updating Print Farm Manager...

git pull
if %errorlevel% neq 0 (
    echo ERROR: git pull failed. Check your internet connection or resolve any conflicts.
    pause
    exit /b 1
)

npm install
if %errorlevel% neq 0 (
    echo ERROR: npm install failed.
    pause
    exit /b 1
)

cd client
npm install --legacy-peer-deps
if %errorlevel% neq 0 (
    echo ERROR: client npm install failed.
    cd ..
    pause
    exit /b 1
)

npm run build
if %errorlevel% neq 0 (
    echo ERROR: build failed.
    cd ..
    pause
    exit /b 1
)
cd ..

echo Stopping server...
rem NOTE: taskkill /IM node.exe stops ALL Node.js processes on this machine,
rem not just the print farm server. This is fine on a dedicated farm machine,
rem but if you are running other Node-based tools (e.g. other servers, CLI tools)
rem at the same time, they will also be stopped. Restart them manually if needed.
taskkill /F /IM node.exe 2>nul
timeout /t 2 /nobreak >nul

echo Starting server...
start "" /MIN node server\index.js

echo.
echo Done! Print Farm Manager is up to date and running.
pause
