# Renderへのデプロイ手順

## バックエンド（Render）

### 1. GitHubリポジトリの作成
```bash
cd c:\Users\userv\Downloads\Bot\sui-clmm-bot-dashboard
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/sui-clmm-bot.git
git push -u origin main
```

### 2. Renderでデプロイ
1. https://render.com にアクセス
2. GitHubでサインイン
3. "New +" → "Blueprint"
4. リポジトリを選択
5. render.yamlが自動読み込み
6. 環境変数を確認：
   - PRIVATE_KEY: あなたの秘密鍵を入力
7. "Apply" をクリック

### 3. デプロイ完了
- URL: `https://sui-clmm-bot-backend.onrender.com`
- ヘルスチェック: `https://sui-clmm-bot-backend.onrender.com/health`

## フロントエンド（Vercel）

### 1. API URLの変更
frontend_v2/src/App.tsx のAPI URLをRenderのURLに変更

### 2. Vercelにデプロイ
```bash
cd frontend_v2
npm install -g vercel
vercel
```

## 費用
- Render Standard: $7/月
- Vercel: 無料
