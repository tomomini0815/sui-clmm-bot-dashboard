# デプロイ手順

## バックエンドの選択肢（無料枠あり）

### オプション 1: Railway（推奨・無料枠あり）
- 無料クレジット: $5/月（約500時間）
- 常時稼働可能
- データベース不要（ファイル永続化対応）

### オプション 2: Fly.io（無料枠あり）
- 無料VM: shared-cpu-1x（256MB RAM）
- 常時稼働可能
- グローバルエッジネットワーク

### オプション 3: Render（有料）
- Standard: $7/月

---

## オプション 1: Railway へのデプロイ

### 1. GitHubリポジトリの準備
```bash
cd /path/to/sui-clmm-bot-dashboard
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/sui-clmm-bot-dashboard.git
git push -u origin main
```

### 2. Railwayでデプロイ
1. https://railway.app にアクセス
2. GitHubでサインイン
3. "New Project" → "Deploy from GitHub repo"
4. リポジトリを選択
5. `railway.json` が自動認識
6. 環境変数を設定:
   - `PRIVATE_KEY`: あなたの秘密鍵
   - `SUI_RPC_URL`: `https://fullnode.mainnet.sui.io:443`
   - `TELEGRAM_BOT_TOKEN`: （任意）
   - `TELEGRAM_CHAT_ID`: （任意）
7. "Deploy" をクリック

### 3. デプロイ完了
- URL: `https://your-project.railway.app`
- ヘルスチェック: `https://your-project.railway.app/health`
- ダッシュボードでログを確認可能

### Railwayの無料枠
- $5 クレジット/月
- 常時稼働で約500時間
- 1ヶ月未満の場合は無料で利用可能

---

## オプション 2: Fly.io へのデプロイ

### 1. Fly CLI のインストール
```bash
# macOS
brew install flyctl

# Linux/WSL
curl -L https://fly.io/install.sh | sh
```

### 2. ログイン
```bash
fly auth login
```

### 3. アプリの作成
```bash
cd /path/to/sui-clmm-bot-dashboard
fly launch --name sui-clmm-bot-backend --region nrt
```

### 4. 環境変数の設定
```bash
fly secrets set PRIVATE_KEY="your_private_key_here"
fly secrets set SUI_RPC_URL="https://fullnode.mainnet.sui.io:443"
fly secrets set TELEGRAM_BOT_TOKEN="your_token"  # 任意
fly secrets set TELEGRAM_CHAT_ID="your_chat_id"  # 任意
```

### 5. デプロイ
```bash
fly deploy
```

### 6. デプロイ完了
- URL: `https://sui-clmm-bot-backend.fly.dev`
- ヘルスチェック: `https://sui-clmm-bot-backend.fly.dev/health`
- ログ確認: `fly logs`

### Fly.io の無料枠
- shared-cpu-1x VM: 無料
- 月3GBの転送量
- 256MB RAM（ボットには十分）

---

## オプション 3: Render へのデプロイ

### 1. GitHubリポジトリの作成
```bash
cd /path/to/sui-clmm-bot-dashboard
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/sui-clmm-bot-dashboard.git
git push -u origin main
```

### 2. Renderでデプロイ
1. https://render.com にアクセス
2. GitHubでサインイン
3. "New +" → "Blueprint"
4. リポジトリを選択
5. render.yamlが自動読み込み
6. 環境変数を確認:
   - PRIVATE_KEY: あなたの秘密鍵を入力
7. "Apply" をクリック

### 3. デプロイ完了
- URL: `https://sui-clmm-bot-backend.onrender.com`
- ヘルスチェック: `https://sui-clmm-bot-backend.onrender.com/health`

### Render の料金
- Standard: $7/月

---

## フロントエンド（Vercel）- 全オプション共通

### 1. API URLの変更
`frontend/src/App.tsx` のAPI URLをバックエンドのURLに変更:

```typescript
const [apiUrl, setApiUrl] = useState(() => 
  localStorage.getItem('api_url_v2') || 
  (import.meta.env.PROD ? 'https://your-backend-url.com' : 'http://localhost:3002')
);
```

### 2. Vercelにデプロイ
```bash
cd frontend
npm install -g vercel
vercel
```

または:
1. https://vercel.com にアクセス
2. GitHubリポジトリを選択
3. フレームワークプリセット: Vite
4. デプロイ

### Vercel の料金
- Hobbyプラン: 無料
- 自動HTTPS
- グローバルCDN

---

## 費用比較

| プラットフォーム | 月額費用 | 無料枠 | 常時稼働 |
|-----------------|---------|--------|----------|
| **Railway**     | $0〜    | $5/月  | ✅ |
| **Fly.io**      | $0      | 無料VM | ✅ |
| **Render**      | $7      | なし   | ✅ |
| **Vercel (FE)** | $0      | 無料   | ✅ |

### 推奨構成（完全無料）
- バックエンド: Fly.io（無料VM）
- フロントエンド: Vercel（無料）
- **合計: $0/月**

---

## トラブルシューティング

### ヘルスチェックが失敗する場合
- ボットが正常に起動しているかログを確認
- 環境変数 `PRIVATE_KEY` が正しく設定されているか確認
- ポート番号（3002）が開放されているか確認

### ファイル永続化の問題
- Railway: 自動永続化
- Fly.io: ephemeral storage（再起動でデータ消失）
  - 重要なデータは外部DB（Supabase等）を検討

### 無料枠の制限
- Railway: 課金しない場合、クレジット終了後に停止
- Fly.io: 256MB RAM限制約
- Render: 無料プランは30分でスリープ
