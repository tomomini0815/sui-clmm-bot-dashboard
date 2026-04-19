# SUI CLMM Bot Dashboard

Delta-Neutral Profit Engine • V3.0

[![Deploy to Fly.io](https://fly.io/docs/images/deploy-to-fly.svg)](https://fly.io/launch?repo=https://github.com/tomomini0815/sui-clmm-bot-dashboard)

## 🚀 クイックスタート（3分で完了）

1. バックエンドをデプロイ
   - 以下の「デプロイガイド」を確認して、お好みの環境を選択してください。
   - **推奨（完全無料）**: ローカルPCで常時稼働
   - **クラウド**: Fly.io または Railway（要クレジットカード/デポジット）

2. フロントエンドにアクセス
   - [Vercelで公開中のフロントエンド](https://your-frontend.vercel.app) にアクセス（またはローカルで `npm run dev`）

3. 設定完了
   - SetupWizardで以下の情報を入力：
     - **API URL**: バックエンドのURL（例: `http://localhost:3002` または Fly.io等のURL）
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

## 💰 費用（2026年最新）

| プラットフォーム | 費用 | 特徴 |
|-----------------|------|----------|
| **ローカルPC**   | **$0** | 自分のPCをつけっぱなしにする（最も安全・確実） |
| **Fly.io**      | $0〜 | 要クレジットカード。無料枠はあるが新規登録は厳しい場合あり |
| **Railway**     | $0〜 | クレジットカードなしで開始可（初回特典$5終了後は有料） |
| **Vercel**      | $0 | フロントエンド（ダッシュボード）の公開に使用 |

> [!NOTE]
> 24時間稼働の監視ボットをクラウドで動かすには、現在ほとんどのサービスでクレジットカード登録が必要になっています。

## 🤝 マルチユーザー対応

このアプリはマルチユーザーに対応しています。各ユーザーが自分のFly.ioインスタンスを持つことで、安全に独立して使用できます。

詳細は[デプロイガイド](./DEPLOY.md)をご覧ください。

## ⚠️ 免責事項

このボットは教育・研究目的で提供されています。投資助言ではありません。使用は自己責任でお願いします。

## 📄 ライセンス

MIT License
