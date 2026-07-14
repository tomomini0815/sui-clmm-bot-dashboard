# Sui LP Rebalancer — gridBOT-standalone

> **レンジ相場・往復相場に特化した逆張りグリッドBOT**  
> Sui上のCetus / Turbos CLMM DEXにおいて、LP（流動性）ポジション1本1本を指値注文のように扱い、約定のたびに反対側へ自動で置き直す。

---

## ⚠️ 設計上の注意

このBOTは **レンジ相場・往復する相場** に向いており、強いトレンド相場では在庫（どちらかのトークン）が偏り続けます。  
一方向に価格が動き続ける場面では意図的にBOTを停止または設定調整することを推奨します。

---

## ディレクトリ構成

```
gridBOT-standalone/
├── src/
│   ├── types.ts          # 全共通型定義
│   ├── utils.ts          # tick計算・LP向き判定・グリッド幅計算
│   ├── state.ts          # 状態永続化（JSONファイル）
│   ├── grid.ts           # BOTコアロジック（initGrid・processFill・runCycle）
│   ├── auto-tune.ts      # 自動調整ロジック群
│   ├── cetus-grid.ts     # Cetus DEXアダプタ（要SDK接続）
│   ├── turbos-grid.ts    # Turbos DEXアダプタ（要SDK接続）
│   └── main.ts           # BOTエントリーポイント
├── server/
│   └── index.ts          # Express + WebSocket API（ダッシュボード用）
├── dashboard/            # Webダッシュボード（React + Vite）
├── data/
│   └── state.json        # BOT状態永続化ファイル（自動生成）
├── .env.example          # 環境変数テンプレート
└── README.md
```

---

## セットアップ

```bash
# 依存インストール
npm install

# ダッシュボード依存インストール
cd dashboard && npm install && cd ..

# 環境変数設定
cp .env.example .env
# .env を編集: ウォレット秘密鍵・RPC URL を設定
```

---

## 環境変数（主要項目）

| 変数 | 説明 | デフォルト |
|------|------|-----------|
| `GRID_WALLET_PRIVATE_KEY` | グリッド用ウォレット秘密鍵 | 必須 |
| `GAP_WALLET_PRIVATE_KEY` | 空白BOT用ウォレット秘密鍵 | 任意 |
| `SUI_RPC_URL` | Sui RPCエンドポイント | mainnet |
| `GRID_POOLS` | 対象プール（カンマ区切り） | 全プール |
| `GRID_WIDTH_PCT` | グリッド幅（%） | 2 |
| `GRID_LEVELS_UP` | 上方向グリッド本数 | 3 |
| `GRID_LEVELS_DOWN` | 下方向グリッド本数 | 3 |
| `GRID_CAPITAL_A` | sell側トークンA投入量 | 1000000000 |
| `GRID_CAPITAL_B` | buy側トークンB投入量 | 1000000 |
| `AUTO_REINIT_ENABLED` | 自動再初期化 | true |
| `AUTO_REBALANCE_ENABLED` | 在庫自動リバランス | true |

---

## 起動方法

```bash
# BOTプロセスのみ起動
npm run bot

# ダッシュボードAPIサーバーのみ起動
npm run server

# ダッシュボード開発サーバー（別ターミナル）
cd dashboard && npm run dev

# 両方同時起動
npm run dev
```

ダッシュボード: http://localhost:5173  
バックエンドAPI: http://localhost:3001

---

## コアロジック概要

### グリッドBOTの動作原理（仕様 2.1〜2.9）

```
[100,110] に sell(A) LP を設置
  ↓ 価格が110以上に上抜け
→ A が売れて B になる
→ [90,100] に buy(B) LP を置き直す

[90,100] に buy(B) LP を設置
  ↓ 価格が90未満に下抜け
→ B で A を買い戻す
→ [100,110] に sell(A) LP を置き直す
```

**損益は往復完了時のみ計上**（片道約定は未実現として扱う）

### 初期グリッド自動生成（仕様 2.10）

BOT起動時にLPが0件の場合、`initGrid()` が自動実行される:
1. 現在tick・価格を取得
2. `GRID_WIDTH_PCT` からtick幅を算出（tickSpacingの倍数に丸め）
3. 現在価格の直上に `GRID_LEVELS_UP` 本の sell LP
4. 現在価格の直下に `GRID_LEVELS_DOWN` 本の buy LP
5. `multiOpenPositions()` で1トランザクション一括発注

### 安全ガード

全自動処理に以下のガード条件を実装済み:
- `MAX_OPENS_PER_CYCLE`: 1周回あたり最大発注数
- `MAX_OPENS_PER_DAY`: 1日あたり最大発注数
- `REBALANCE_COOLDOWN_SEC`: リバランスクールダウン
- `FUND_TRANSFER_DAILY_MAX`: 資金移動1日上限回数
- `FUND_TRANSFER_DAILY_LIMIT`: 資金移動1回あたり上限額

---

## SDKへの接続（本番利用時）

`src/cetus-grid.ts` / `src/turbos-grid.ts` の `// TODO:` コメント部分を実際のSDK呼び出しに差し替えてください:

```typescript
// TODO: Replace with real Cetus SDK call
// const positions = await sdk.Position.getPositionList(walletAddress, [poolAddress]);
```

必要なSDK:
- Cetus: `@cetusprotocol/cetus-sui-clmm-sdk`
- Turbos: `@turbos-finance/sdk`
- Sui: `@mysten/sui`

---

## ダッシュボード機能

- リアルタイムポジション監視（WebSocket）
- 成績サマリー（純利益 = 差益 + LP手数料 - swap手数料）
- 戦略別カード（Grid/Gap × Cetus/Turbos）
- 監視設定の自動/手動切替
- 重要イベント履歴
- ウォレット残高表示
- ログパネル（フィルタ付き）
