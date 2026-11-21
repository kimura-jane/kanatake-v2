# 来店ポイント v2: Cloudflare 側実装引き継ぎ（本番未適用）

この文書はアプリ側の **feature/offline-checkin-20261121** ブランチとの連携契約です。
アプリ側では QR ライブラリを同梱済み、GPS は任意、オフライン仮受付を端末に永続保存します。
**Cloudflare Worker / D1 の変更と本番投入は別途、運営者が行ってください。**

## 新しい API

既存ユーザー向け `POST /checkin` は変更せず、`POST /checkin-v2` を新設することを推奨。

`POST https://kanatake-api.la-kofu.workers.dev/checkin-v2`

Content-Type: `application/json`

```json
{
  "device_id": "dev_...（既存IDを維持）",
  "request_id": "e13901cb-...（同一仮受付では常に同じID）",
  "qr_data": "読み取ったQRの文字列",
  "scanned_at": "2026-11-21T04:00:00.000Z",
  "scanned_date_jst": "2026-11-21",
  "spot_name": "出店場所（不明なら空文字）",
  "latitude": null,
  "longitude": null,
  "accuracy": null
}
```

GPS 座標・精度は任意。取得できなくても来店可否を拒否しない。
`spot_name`・端末時刻・QR の中身は **クライアント申告値であり来店の証明ではない**。

## 応答契約

- 成功: HTTP 200 `{"ok":true,"current_points":17}`（残高の確定値を返す）
- 同一日付の重複: HTTP 409 `{"error":"already checked in today","current_points":17}`
- 回復可能な障害: HTTP 5xx、429 などを返す。クライアントが仮受付を維持して再送する
- 無効な受付: HTTP 400/403 `{"error":"..."}`。クライアントは要確認として記録を残す
- `/checkin-v2` が未公開なら HTTP 404。クライアントは仮受付として保存したまま待機する

## サーバーで必ず保証すること

1. ポイント付与は **JST の1端末・1日1回**。既存の `checkin_logs` に同日の記録がある場合も重複扱いにする
2. `request_id` を保存して、同じ仮受付を再送しても **ポイントを二重加算しない**
3. 来店履歴・ポイント残高・重複防止記録を **D1 の原子的トランザクション** で確定する。Cloudflare D1 の `DB.batch()` を用いる場合、途中エラー時に全件ロールバックされることを確認する
4. `scanned_at` / `scanned_date_jst` とサーバー時刻の差を検査する。オフライン時刻は改ざん可能。許容遅延（例48時間）を決める
5. `qr_data` の検証方式を運営者が決める。現行コードはQR内容を照合しておらず、今回もシール変更は範囲外。PayPay / HashPort の決済QRを許諾なしに転用しない
6. 管理者の手動付与、ポイント交換、既存クーポン、旧アプリの `/checkin` を破壊しない
7. 成功時以外、ポイント表示をアプリ側で先に増加させない

## 公開手順

1. 本番 D1 のテーブル構造・制約を確認し、バックアップ
2. `/checkin-v2` を追加しテスト（GPSあり/なし、オフライン翌日再送、同日重複、同一 request_id 再送、同時送信、20pt交換前後）
3. サーバー側が安定してからこのブランチのアプリ変更を公開・ビルド
4. TestFlight / Android / ブラウザ版でカメラ権限・機内モード・再起動後の再送・通信障害のケースを検証

## アプリ側の修正対象

- `www/vendor/html5-qrcode.min.js`: html5-qrcode 2.3.8 の完全ローカル同梱
- `www/vendor/LICENSE-html5-qrcode.txt`: Apache-2.0 ライセンス
- `www/checkin-offline.js`: 端末永続化、request_id、再送
- `www/app.js`: GPS任意のQR受付・仮受付表示・前面復帰時の再送
- `www/index.html`: ローカルQRライブラリと表示文言
- `www/sw.js`: PWAキャッシュ更新

注意：アプリを閉じた状態での送信を保証するものではありません。アプリ起動・前面復帰・オンライン復帰で再送します。
