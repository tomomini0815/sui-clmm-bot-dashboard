# macOS 自動起動

Sui Bot のバックエンドとフロントエンドは `launchd` で常駐させます。

- macOSへのログイン時に自動起動
- Botまたはフロントエンドの異常終了時は5秒後に自動再起動
- フロントエンド起動後に既定ブラウザでダッシュボードを表示
- 監視プロセス自体の異常終了時も `launchd` が再起動
- ログは10MBごとにローテーションし、最大5世代を保持
- 過去のPM2ログは監視プロセス起動時に各2MBまで縮小

## 状態確認

```bash
launchctl print gui/$(id -u)/com.tomomi.sui-bot
curl http://127.0.0.1:3002/health
curl http://127.0.0.1:5174/
```

## ログ確認

```bash
tail -f bot_v2/logs/supervisor.log
```

## 再起動

```bash
launchctl kickstart -k gui/$(id -u)/com.tomomi.sui-bot
```

## 停止

```bash
launchctl bootout gui/$(id -u)/com.tomomi.sui-bot
```

`LaunchAgent` のため、端末再起動後はユーザーがmacOSへログインした時点で起動します。
電源を切らず24時間運用する場合は、電源アダプタへの接続とネットワーク接続を維持してください。
