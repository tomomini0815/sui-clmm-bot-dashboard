@echo off
TITLE Sui CLMM Bot System
chcp 65001 >nul
echo ==================================================
echo Sui CLMM Bot System Launch
echo ==================================================
echo.

:: 実行フォルダを取得
set "ROOT_DIR=%~dp0"

:: Node.jsのインストール確認
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js が見つかりません！
    echo https://nodejs.org/ から Node.js をインストールしてください。
    pause
    exit /b
)

:: バックエンドの準備
echo [1/2] バックエンド(bot_v2)の準備をしています...
cd /d "%ROOT_DIR%bot_v2"
if not exist "node_modules\" (
    echo 初回起動: バックエンドのライブラリをインストールしています...
    cmd /c "npm install"
)

:: .envファイルの確認
if not exist ".env" (
    echo [WARNING] .env ファイルが見つかりません。
    echo .env.example を元に .env を自動作成しました。
    copy .env.example .env
    echo bot_v2 フォルダ内の .env を開いて、PRIVATE_KEY を入力してから再度実行してください！
    pause
    exit /b
)

echo バックエンドサーバーを起動中...
start "Bot-Backend" powershell -NoExit -Command "npm start"

:: フロントエンドの準備
echo.
echo [2/2] フロントエンド(ダッシュボード)の準備をしています...
cd /d "%ROOT_DIR%frontend"
if not exist "node_modules\" (
    echo 初回起動: フロントエンドのライブラリをインストールしています...
    cmd /c "npm install"
)
echo フロントエンドサーバーを起動中...
start "Bot-Frontend" powershell -NoExit -Command "npm run dev"

echo.
echo ==================================================
echo 全てのサーバーの起動プロセスをリクエストしました！
echo 数秒待つと、以下の環境が立ち上がります。
echo.
echo バックエンド   : http://localhost:3002
echo ダッシュボード : http://localhost:5173 
echo.
echo ブラウザで http://localhost:5173 にアクセスしてください。
echo (※起動中は黒い画面を閉じないでください)
echo ==================================================
pause
