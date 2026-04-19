# 🚀 デプロイガイド

## ワンクリックデプロイ（最速・簡単！）

[![Deploy to Fly.io](https://fly.io/docs/images/deploy-to-fly.svg)](https://fly.io/launch?repo=https://github.com/tomomini0815/sui-clmm-bot-dashboard)

上記のボタンをクリックするだけで、Fly.ioに自動デプロイされます！

### 手順（約3分）
1. 上の「Deploy to Fly.io」ボタンをクリック
2. GitHubアカウントで認証
3. Fly.ioアカウントに接続（初回のみ）
4. アプリ名を入力（例: `my-sui-bot`）
5. 環境変数を設定:
   - `PRIVATE_KEY`: あなたのSui秘密鍵（`suiprivkey...`）
   - `SUI_RPC_URL`: `https://fullnode.mainnet.sui.io:443`
6. 「Launch App」をクリック
7. 完了！URLが発行されます

### デプロイ後
発行されたURL（例: `https://my-sui-bot.fly.dev`）をフロントエンドのSetupWizardで入力してください。

---

## バックエンドの選択肢（無料枠あり）

### オプション 1: ローカルPC（推奨・完全無料）
- 費用: $0（電気代のみ）
- 難易度: 低
- 必須条件: PCを24時間起動したままにする

### オプション 2: Fly.io（要クレジットカード）
- 費用: $0
- 必須条件: クレジットカード登録による本人確認
- 注意: 2026年現在、新規アカウントの「永続無料」は厳しくなっています

### オプション 3: Railway（トライアル無料）
- 特典: 初回 $5 クレジット
- 必須条件: GitHubアカウント（カード不要で開始可）
- 注意: クレジット終了後は有料となります

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

### ⚠️ 注意点
- **クレジットカード必須**: 無料枠の範囲内であっても、本人確認のために有効なカード（またはデビットカード）の登録が求められます。
- **デプロイ不可のエラー**: カード登録がない場合、`fly deploy` 時にエラーが発生します。

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

## 🏠 オプション 0: ローカルPCで24時間稼働

クラウドを使わず、手元のPCをサーバーとして使う最も確実な方法です。

### 1. 起動方法
1. プロジェクトルートの `start_bot.bat` をダブルクリックして実行します。
2. 他の作業中もコマンドプロンプトを閉じないでください。

### 2. PCの設定（重要）
ボットを止めないために以下の設定を行ってください：

*   **スリープ設定（Windows）**:
    - 「設定 > システム > 電源とスリープ」で、電源接続時のスリープを **[なし]** に設定してください。
*   **Windows Update**:
    - 夜間の自動再起動でボットが止まることがあります。定期的に（週末など）手動でアップデートして再起動する習慣をつけると安定します。
*   **モニターの電源**:
    - 画面（モニター）の電源だけを切るのは問題ありません。

### 3. メリット・デメリット
- **メリット**: 費用が一切かからず、自分の管理下で動かせるため秘密鍵の漏洩リスクが最も低いです。
- **デメリット**: PCをつけっぱなしにする必要があるため、多少の電気代がかかります。

---

## 費用比較（2026年最新）

| プラットフォーム | 推定費用 | カード登録 | 安定性 |
|-----------------|---------|--------|----------|
| **ローカルPC**   | **$0**  | **不要** | 中（停電やネット切断に依存） |
| **Railway**     | $0〜$5  | 不要(開始時) | 高 |
| **Fly.io**      | $0〜$5  | **必要** | 高 |

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
