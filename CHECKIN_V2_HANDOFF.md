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

## v1.4.0 対応資料（作業用ブランチ）

- Cloudflare Worker の全文: [`cloudflare/worker-1.4.0.js`](cloudflare/worker-1.4.0.js)
- D1 に追加する SQL: [`cloudflare/migration-checkin-v2.sql`](cloudflare/migration-checkin-v2.sql)
- 本番の Worker / D1 へ自動適用は行っていない

### 必須の適用順

1. 本番DBをバックアップし、`PRAGMA table_info(checkin_logs);`、`PRAGMA table_info(stamp_points);`、`SELECT name,sql FROM sqlite_master WHERE name IN ('checkin_logs','stamp_points');` で実スキーマを確認する
2. そのスキーマが `checkin_logs(device_id,location_id,spot_name,checked_in_at)` / `stamp_points(device_id,current_points,megami_coupon_active)` を満たすことを確認してから、SQLを手動適用
3. テスト環境で旧API・新APIのチェックイン／リトライ／同日重複／JST日付／既存ポイント維持を確認
4. Worker全文を手動で置換・デプロイ（Cloudflare Dashboardでは `export default` を含むモジュールを貼り付ける）
5. `feature/offline-checkin-20261121` をレビュー後にアプリ公開。先にアプリを公開しない

### 重要な仕様と制約

- 新APIはGPSを要求しないが、QRの有効性もまだ確認していない。現時点では非空QRなら受付対象となる
- `request_id` は同じ受付の再送時に固定。受け付け済みの再送は追加付与しない
- オフラインの `scanned_at` は端末申告であり、日時改ざんを完全には防げない
- QRライブラリの同梱でカメラを通信なしで起動できるが、新APIへの通信が復旧するまでポイントは確定しない
- 現行 `checkin_logs` の日時、`stamp_points` の初期値や既存制約が上記と異なる場合、提示コードをそのまま適用しない
- 新旧の `/checkin` と `/checkin-v2` は同一の原子的付与処理を共有する。古いアプリでは従来どおりGPS位置判定が残る

## 2026-11-21 GitHub追加修正

- QRスキャナーの連続通知をガードし、同じ読み取りを並列処理しない
- API障害時の送信連打を停止する。送信中に新たな受付が発生した場合は追加処理する
- 自動回帰テスト: `npm test`（`node --test tests/checkin-offline.test.cjs`）
- iOSとAndroidの仮受付キューとスキャナーは同一内容を使用
- **Cloudflare側の正本は`kanatake-api`の確認用ブランチ。`cloudflare/worker-1.4.0.js`は2026-11-22に正本と同期した検証用コピーであり、本番デプロイには使わないこと。**
- D1の`checkin_claims_v2`はユーザー画面で存在確認済み。既存のデータは変更せず、Codexで制約を再確認する
- 本番APIの動作・App Storeでの1.4.0の掲載状態・実機動作は未確認。公開前に必ず検証

## 監査B判定へのGitHub対応（2026-11-21）
- CodexのWorker下書きが交換時に20ポイントだけ減算する仕様に合わせ、交換後に0を固定表示する不具合を修正
- 交換直後はサーバーが返した`current_points`を使用、未返却なら`/points`を再取得
- 再取得もできなければ残高を「確認中」とし、誤った数値を表示しない
- 交換の連続タップを抑止し、交換確認文も「20ポイント消費・超過分は残る」に変更
- 回帰テストを`tests/redeem-points.test.cjs`に追加。iOSは`npm test`で両テストを実行
- Workerの現在の実コードはCodexのローカル`worker-draft.mjs`に保存されており、GitHub参考Workerとは別。Codex側のコードでデプロイ前にAPI契約を確認すること
- Codex監査はB判定、クラウド本番への変更は未実施。受付の過去・未来許容期間は運用者の決定待ち。新APIを本番公開してからアプリを公開する

## 2026-11-21 最終Worker契約対応（client-compatibility.md / worker-final.mjs照合済み）

- `/points` の`current_points`、`total_redeemed`、`megami_coupon_active`を検証してUIへ反映する
- `/redeem-points`には`device_id`、`required_points:20`、保存済みUUIDの`request_id`、操作開始時の`coupon_generation=total_redeemed`を送信する
- `/megami-coupon/use`には`device_id`、同じ仕組みで保存した`request_id`と`coupon_generation`を送る
- 操作IDは`coupon-operations.js`に保存し、通信エラー／5xx時にも再生成しない。未確定操作を確認するボタンを設置し、**店頭でのクーポン使用は自動再送しない**
- HTTP 200 `replayed:true` は再実行ではなく同じ操作の再確認として表示。409は最新`/points`を読み、古い未確定操作を終える
- FiNANCiE保有クーポンは`coupon_id`を行単位で送信。同じ`code`の別保有行を誤って使わない
- `checkin_expired`は最終Workerの`code`フィールドを読み、90日超の記録を残して詳細表示する
- 回帰テスト：`tests/checkin-offline.test.cjs`（6件）、`tests/redeem-points.test.cjs`（6件）、`tests/financie-coupon.test.cjs`（3件）
- **注意：添付`worker-final.mjs`はCloudflare本番に未デプロイ。新Workerには`coupon_operations_v1`のD1移行が必要。** GitHubのWorker参考コードを本番に直接デプロイしない
- **旧アプリは`request_id`と`coupon_generation`を送らないため、状態を変える交換・使用は新Workerでは426で拒否される。状態により400または409になる。** 旧アプリでは使用失敗が画面に表示されないため、切替前に利用者案内・実機確認が必要
- Android側`main`の12月出店情報（`spots-feed.json`）は保持。GitHub作業ブランチのみを更新し、本番アプリ／Worker／D1は未変更

## 2026-11-22 最終公開前の注意（旧説明より優先）

- **Workerの正本は `kimura-jane/kanatake-api` の `fix/kanatake-api-safe-20261122` の `src/index.js`**。iOS PR 内の `cloudflare/worker-1.4.0.js` は同期済みの検証用コピーであり、そこから本番デプロイしない。
- Codex が本番D1を読み取り、`checkin_claims_v2` の主キーと `(device_id, checkin_date_jst)` UNIQUE を確認。**`coupon_operations_v1` は本番に未作成**。正しい追加SQLは `kanatake-api/migrations/coupon_operations_v1.sql`。旧手順の参考SQLを流用しない。
- 新Workerは旧アプリの曖昧な交換・使用を安全側で拒否する。状態に応じて **426 `app_update_required`、400、409**。旧アプリの使用ボタンは426を表示しないコードになっているため、既存利用者への更新告知・実機確認が必須。
- iOS・Androidの新アプリは `request_id`・`coupon_generation` を送信するコードに変更済み。ただし両PRはドラフトで、新Workerとの**実機／隔離Cloudflare結合試験は未実施**。
- **本番D1への書き込み、本番Workerのトラフィック切替、mainへのマージ、ストア配信は許可なく行わない**。本番稼働Workerの全文を再確認し、全ルートの欠落がないか比較してから公開判断する。
