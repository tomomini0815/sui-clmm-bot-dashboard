# Sui CLMM LP 自動リバランスボット

このプロジェクトは、Suiブロックチェーン上のCetus Protocolを利用した自動流動性供給（LP）及びヘッジ管理ボットです。

## 特徴
- Cetus ProtocolのSUI/USDCプールにおける自動レンジ設定・流動性供給。
- 価格変動によるレンジ外逸脱時の自動リバランス（既存LP/ヘッジ解除、再計算後再投入）。
- 擬似的なヘッジ管理（Bluefin等の外部DEXインターフェースとして拡張可能）によるデルタニュートラル戦略。
- リッチなCLI表示（chalk, ora, boxen等）とローカルのPnLトラッキング機能。
- （オプション）Telegramを通した通知機能。

## セットアップ手順

1. **Node.jsのインストール**: バージョン `18` 以上環境をご用意ください。
2. **依存パッケージのインストール**:
   以下のコマンドを実行し、パッケージをインストールします。
   ```bash
   npm install
   ```
3. **環境変数の設定**:
   `.env.example` をコピーして `.env` ファイルを作成し、自身のテスト用秘密鍵や設定に書き換えてください。
   ```bash
   cp .env.example .env
   ```
   **設定項目例：**
   - `PRIVATE_KEY`: Suiウォレットの秘密鍵。
   - `SUI_RPC_URL`: 利用するRPC（推奨: `https://fullnode.testnet.sui.io` 意図しない資産の損失を防ぐため、初期設定はテストネットとしています）

## 実行方法

開発モード（ファイル変更時に自動再起動する watch モード）:
```bash
npm run dev
```

本番実行用:
```bash
npm start
```

## モジュール構造

- `src/config.ts`: 環境変数読み込みとバリデーション
- `src/logger.ts`: CUIのUI/UX向上を担当するロガー
- `src/priceMonitor.ts`: Cetus SDKからSUIの価格を監視し、レンジ判定を実行
- `src/lpManager.ts`: Cetusへの流動性追加、削除、手数料収取の管理（一部モック）
- `src/hedgeManager.ts`: 別DEXへのヘッジ構築用モジュール（設計として分離、現状は擬似動作）
- `src/tracker.ts`: 取引履歴や手数料収益等の統計をローカルJSONに保持
- `src/strategy.ts`: メインの投資戦略であるリバランスロジックを管理
