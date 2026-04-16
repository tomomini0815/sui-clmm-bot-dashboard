# SUI CLMM Bot Dashboard

Delta-Neutral Profit Engine • V3.0

[![Deploy to Fly.io](https://fly.io/docs/images/deploy-to-fly.svg)](https://fly.io/launch?repo=https://github.com/tomomini0815/sui-clmm-bot-dashboard)

## 🚀 クイックスタート（3分で完了）

### 1. バックエンドをデプロイ
上の「Deploy to Fly.io」ボタンをクリックして、Fly.ioにバックエンドをデプロイしてください。

### 2. フロントエンドにアクセス
[Vercelで公開中のフロントエンド](https://your-frontend.vercel.app)にアクセス

### 3. 設定完了
SetupWizardで以下の情報を入力：
- **API URL**: Fly.ioで発行されたURL（例: `https://my-sui-bot.fly.dev`）
- **秘密鍵**: あなたのSui Walletの秘密鍵

## ✨ 機能

- 🔄 自動リバランス（Cetus CLMM）
- 📊 リアルタイム価格監視
- 🛡️ デルタニュートラル戦略
- 💰 手数料自動収集
- 📱 Telegram通知
- 📈 ダッシュボード

## 📚 ドキュメント

- [デプロイガイド](./DEPLOY.md)
- [フロントエンド](./frontend/)
- [バックエンド](./bot_v2/)

## 🛠️ 技術スタック

**フロントエンド**
- React 19 + TypeScript
- Vite
- Recharts
- Lucide React

**バックエンド**
- Node.js + Express
- TypeScript
- Cetus SDK
- @mysten/sui

## 💰 費用

- **Fly.io**: 無料枠あり（shared-cpu-1x、256MB RAM）
- **Vercel**: 無料（フロントエンド）
- **合計**: $0/月〜

## 🤝 マルチユーザー対応

このアプリはマルチユーザーに対応しています。各ユーザーが自分のFly.ioインスタンスを持つことで、安全に独立して使用できます。

詳細は[デプロイガイド](./DEPLOY.md)をご覧ください。

## ⚠️ 免責事項

このボットは教育・研究目的で提供されています。投資助言ではありません。使用は自己責任でお願いします。

## 📄 ライセンス

MIT License
