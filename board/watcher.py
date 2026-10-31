
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
おにぎり屋かなたけ — 販売ボード生成ワーカー

GitHub Actions: python3 watcher.py --once
旧Muse常駐運用: python3 watcher.py

生成済み判定の正はWorkerの /muse/today にある。
ローカル状態ファイルはInstagram用の補助記録だけに使用する。
"""
import argparse
import json
import os
import re
import sys
import time
from datetime import date, datetime, timedelta, timezone
from urllib.parse import parse_qs, urlsplit

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import adapter

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
JST = timezone(timedelta(hours=9))
STORY_MIN_INTERVAL_MIN = 12
MAX_SYNC_ROUNDS = 4
MAX_IMAGE_BYTES = 5 * 1024 * 1024
SUCCESS_RESULTS = {"generated", "idle_current", "already_registered", "idle_not_live"}


def log(message):
    now = datetime.now(JST).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{now}] {message}", flush=True)


class HttpError(Exception):
    def __init__(self, status):
        super().__init__(f"HTTP {status}")
        self.status = status


class SalesClient:
    def __init__(self, base_url, token, timeout=(10, 45)):
        self.base = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout

    def _request(self, method, path, data=None, headers=None):
        request_headers = {
            "Authorization": "Bearer " + self.token,
            "User-Agent": "kanatake-board-runner/2.0",
        }
        request_headers.update(headers or {})
        response = requests.request(
            method,
            self.base + path,
            data=data,
            headers=request_headers,
            timeout=self.timeout,
            allow_redirects=False,
        )
        return response.status_code, response.content

    def get_today(self):
        status, raw = self._request("GET", "/muse/today")
        if status != 200:
            raise HttpError(status)
        data = json.loads(raw.decode("utf-8"))
        if not isinstance(data, dict):
            raise ValueError("/muse/today の形式が不正です")
        return data

    def put_board(self, board_path, version):
        with open(board_path, "rb") as handle:
            data = handle.read(MAX_IMAGE_BYTES + 1)
        if not data or len(data) > MAX_IMAGE_BYTES:
            raise ValueError("生成画像が空、または5MiBを超えています")
        status, _ = self._request(
            "PUT",
            "/muse/board",
            data=data,
            headers={
                "Content-Type": "image/jpeg",
                "X-Sales-Version": str(version),
            },
        )
        return status


def load_state(path):
    initial = {
        "story_enabled_seen": None,
        "story": {"posted": [], "last_posted_at": None},
    }
    if not os.path.exists(path):
        return initial
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else initial
    except (OSError, ValueError) as exc:
        log(f"補助状態ファイルを読み込めません。無視します: {type(exc).__name__}")
        return initial


def save_state(path, state):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    temporary = path + ".tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(state, handle, ensure_ascii=False, indent=2)
    os.replace(temporary, path)


def save_state_best_effort(path, state):
    try:
        save_state(path, state)
    except OSError as exc:
        log(f"補助状態の保存をスキップ: {type(exc).__name__}")


def story_decision(today, state, now=None):
    """将来のInstagram用判定。現在は投稿しない。"""
    now = now or datetime.now(JST)
    if not today.get("story_enabled"):
        return "skip", "flag_off"
    if today.get("phase") != "live" or today.get("closed_for_today"):
        return "skip", "not_live"
    day, version = today.get("day"), today.get("version")
    story = state.get("story") or {}
    posted = story.get("posted") or []
    if any(p.get("day") == day and p.get("version") == version
           for p in posted if isinstance(p, dict)):
        return "skip", "already_posted"
    last = story.get("last_posted_at")
    if last:
        try:
            last_dt = datetime.fromisoformat(last)
            if last_dt.tzinfo is None:
                last_dt = last_dt.replace(tzinfo=JST)
            if (now - last_dt).total_seconds() < STORY_MIN_INTERVAL_MIN * 60:
                return "wait", "too_soon"
        except (TypeError, ValueError):
            pass
    return "due", "new_version"


def record_story_post(state, day, version, media_id, now=None):
    """将来の実投稿成功時だけ呼ぶ。現在のワーカーからは呼ばない。"""
    now = now or datetime.now(JST)
    story = state.setdefault("story", {"posted": [], "last_posted_at": None})
    story.setdefault("posted", []).append({
        "day": day,
        "version": version,
        "media_id": media_id,
        "posted_at": now.isoformat(),
    })
    story["last_posted_at"] = now.isoformat()


def is_live(today):
    return today.get("phase") == "live" and not today.get("closed_for_today")


def validate_snapshot(today):
    day = today.get("day")
    version = today.get("version")
    if not isinstance(day, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
        raise ValueError("営業日が不正です")
    if date.fromisoformat(day).isoformat() != day:
        raise ValueError("営業日が実在しません")
    if isinstance(version, bool) or not isinstance(version, int) or version < 1:
        raise ValueError("販売versionが不正です")
    return day, version


def is_current_board(today):
    """Worker v5は現在versionの公開可能画像がある場合だけboard_urlを返す。"""
    if not is_live(today):
        return False
    try:
        _, version = validate_snapshot(today)
        url = today.get("board_url")
        if not isinstance(url, str) or not url:
            return False
        parsed = urlsplit(url)
        if parsed.scheme != "https" or parsed.path != "/public/board":
            return False
        params = parse_qs(parsed.query)
        return params.get("version") == [str(version)]
    except (TypeError, ValueError):
        return False


def get_latest_or_failure(client):
    try:
        return client.get_today(), None
    except Exception as exc:
        log(f"最新状態の取得に失敗: {type(exc).__name__}: {exc}")
        return None, "fetch_failed"


def run_once(client, state, state_path, work_dir):
    today, failure = get_latest_or_failure(client)
    if failure:
        return failure

    if state.get("story_enabled_seen") != today.get("story_enabled"):
        state["story_enabled_seen"] = today.get("story_enabled")
        save_state_best_effort(state_path, state)
    decision, reason = story_decision(today, state)
    log(f"story判定: {decision} ({reason}) ※投稿しません")

    if not is_live(today):
        return "idle_not_live"

    os.makedirs(work_dir, exist_ok=True)
    for round_number in range(1, MAX_SYNC_ROUNDS + 1):
        if not is_live(today):
            return "idle_not_live"
        try:
            day, version = validate_snapshot(today)
        except (TypeError, ValueError) as exc:
            log(f"販売データ不正: {exc}")
            return "invalid_snapshot"

        if is_current_board(today):
            return "idle_current"

        board_path = os.path.join(work_dir, f"board_{day}_v{version}.jpg")
        log(f"生成開始 day={day} version={version} round={round_number}")
        try:
            info = adapter.generate(today, board_path)
        except (Exception, SystemExit) as exc:
            log(f"画像生成失敗: {type(exc).__name__}: {exc}")
            return "generate_failed"

        try:
            status = client.put_board(board_path, version)
        except Exception as exc:
            log(f"画像送信失敗: {type(exc).__name__}: {exc}")
            return "upload_failed"

        if status not in (200, 409):
            log(f"画像登録失敗: HTTP {status}")
            return "upload_failed"

        fresh, failure = get_latest_or_failure(client)
        if failure:
            return failure
        if not is_live(fresh):
            return "idle_not_live"

        if is_current_board(fresh):
            if status == 200:
                log(f"公開確認済み day={fresh['day']} version={fresh['version']} items={info['count']}")
                return "generated"
            log(f"別ジョブによる登録を確認 day={fresh['day']} version={fresh['version']}")
            return "already_registered"

        try:
            new_day, new_version = validate_snapshot(fresh)
        except (TypeError, ValueError) as exc:
            log(f"再取得データ不正: {exc}")
            return "invalid_snapshot"

        if new_day == day and new_version == version:
            log(f"登録応答 HTTP {status}、同じversionの公開を確認できません")
            return "conflict_unresolved" if status == 409 else "verify_failed"

        log(f"販売状態が更新されました: {day}/v{version} -> {new_day}/v{new_version}")
        today = fresh

    return "conflict_loop"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default=os.environ.get("KANATAKE_SALES_API_BASE", ""))
    parser.add_argument("--token-env", default="KANATAKE_MUSE_TOKEN")
    parser.add_argument("--state", default=os.path.join(BASE_DIR, "runtime", "watcher_state.json"))
    parser.add_argument("--work-dir", default=os.path.join(BASE_DIR, "runtime", "boards"))
    parser.add_argument("--interval", type=int, default=60)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()

    token = os.environ.get(args.token_env, "")
    if not args.base_url.startswith("https://") or not token:
        parser.error("HTTPSのKANATAKE_SALES_API_BASEとKANATAKE_MUSE_TOKENが必要です")

    client = SalesClient(args.base_url, token)
    state = load_state(args.state)
    log(f"開始 once={args.once} interval={args.interval}s")

    while True:
        try:
            result = run_once(client, state, args.state, args.work_dir)
        except Exception as exc:
            log(f"予期しないエラー: {type(exc).__name__}: {exc}")
            result = "unexpected_error"

        log(f"run_once -> {result}")

        if args.once:
            return 0 if result in SUCCESS_RESULTS else 1

        time.sleep(max(1, args.interval))


if __name__ == "__main__":
    sys.exit(main())
