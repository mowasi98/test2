@echo off
echo ==========================================
echo    SECRET GAME - Anonymous Voting Game
echo ==========================================
echo.
echo Starting server...
echo.

if not exist .env (
    echo Creating .env file...
    echo PORT=3000> .env
    echo SESSION_SECRET=secret-game-session-key-change-in-production>> .env
    echo ADMIN_EMAIL=admin@secretgame.com>> .env
)

if not exist node_modules (
    echo Installing dependencies...
    call npm install
)

echo.
echo Server starting at http://localhost:3000
echo.
echo Press Ctrl+C to stop the server
echo.

node server.js
