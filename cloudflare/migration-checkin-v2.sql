-- おにぎり屋かなたけ v1.4.0
-- Cloudflare D1: 来店チェックインの重複付与を防ぐ新テーブル。
-- 注意: このSQLはユーザーがD1に手動適用する。既存テーブルや既存ポイントを変更しない。
CREATE TABLE IF NOT EXISTS checkin_claims_v2 (
  request_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  checkin_date_jst TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (device_id, checkin_date_jst)
);

-- この新テーブルにはユーザー登録やポイント移行データをコピーしない。
-- 旧版のチェックイン履歴はWorker内でcheckin_logsを読み取って重複判定する。
