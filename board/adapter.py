
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
おにぎり屋かなたけ — 販売ボード画像生成アダプター

GET /muse/today の items[] を make_board.py の描画仕様に変換する。
写真優先順位: image_key のR2写真 → 対応のある従来写真 → 写真準備中。
写真の取得・検証に失敗した場合は生成を失敗させる。
"""
import argparse
import hashlib
import io
import json
import os
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import urljoin, urlsplit

import requests
from PIL import Image, UnidentifiedImageError

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import make_board

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
JST = timezone(timedelta(hours=9))

STATUS_MAP = {
    "selling": "on_sale",
    "low": "low",
    "sold_out": "sold_out",
}
CATEGORY_MAP = {
    "onigiri": "おにぎり",
    "bento": "お弁当",
    "other": "その他",
}

MAX_ITEMS = 16
DEFAULT_PLACEHOLDER_ASPECT = 0.75
MAX_PHOTO_BYTES = 20 * 1024 * 1024
MAX_IMAGE_SIDE = 8000
MAX_DOWNLOAD_ATTEMPTS = 3
MAX_REDIRECTS = 5
RETRYABLE_HTTP = {429, 500, 502, 503, 504}
ALLOWED_FORMATS = {"JPEG", "PNG", "WEBP"}
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) "
    "kanatake-board-adapter/2.0"
)


class AdapterError(Exception):
    pass


class TransientPhotoError(Exception):
    pass


def load_json(path):
    with open(path, encoding="utf-8") as fp:
        return json.load(fp)


def _https_url(url):
    if not isinstance(url, str):
        raise AdapterError("写真URLが文字列ではありません")

    parts = urlsplit(url)
    if (
        parts.scheme.lower() != "https"
        or not parts.hostname
        or parts.username is not None
        or parts.password is not None
    ):
        raise AdapterError(
            "写真URLは認証情報を含まないHTTPS URLにしてください"
        )
    return url


def _check_image(data):
    """画像形式、寸法、デコード可否を検証する。"""
    if not data or len(data) > MAX_PHOTO_BYTES:
        raise AdapterError(
            "写真データが空、または上限20MiBを超えています"
        )

    try:
        with Image.open(io.BytesIO(data)) as im:
            if im.format not in ALLOWED_FORMATS:
                raise AdapterError(
                    "写真形式はJPEG・PNG・WebPのみ対応です"
                )

            w, h = im.size
            if not (
                1 <= w <= MAX_IMAGE_SIDE
                and 1 <= h <= MAX_IMAGE_SIDE
            ):
                raise AdapterError(
                    "写真のピクセル寸法が不正です"
                )
            im.verify()

        with Image.open(io.BytesIO(data)) as im:
            im.load()

    except AdapterError:
        raise
    except (
        OSError,
        ValueError,
        SyntaxError,
        UnidentifiedImageError,
    ) as exc:
        raise AdapterError(
            "写真ファイルが破損しているか読み込めません"
        ) from exc


def _read_photo(url, timeout):
    """HTTPSで写真を取得し、容量制限と画像検査を行う。"""
    current = _https_url(url)

    for _ in range(MAX_REDIRECTS + 1):
        with requests.get(
            current,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "image/jpeg,image/png,image/webp",
            },
            timeout=(10, timeout),
            stream=True,
            allow_redirects=False,
        ) as response:

            if response.status_code in (
                301, 302, 303, 307, 308
            ):
                location = response.headers.get("Location")
                if not location:
                    raise AdapterError(
                        "写真URLのリダイレクト先がありません"
                    )
                current = _https_url(
                    urljoin(current, location)
                )
                continue

            if response.status_code in RETRYABLE_HTTP:
                raise TransientPhotoError(
                    f"HTTP {response.status_code}"
                )

            if response.status_code != 200:
                raise AdapterError(
                    f"写真取得に失敗: HTTP {response.status_code}"
                )

            length = response.headers.get("Content-Length")
            if length is not None:
                try:
                    if int(length) > MAX_PHOTO_BYTES:
                        raise AdapterError(
                            "写真の容量が上限20MiBを超えています"
                        )
                except ValueError:
                    pass

            chunks = bytearray()
            for part in response.iter_content(
                chunk_size=65536
            ):
                if part:
                    chunks.extend(part)
                    if len(chunks) > MAX_PHOTO_BYTES:
                        raise AdapterError(
                            "写真の容量が上限20MiBを超えています"
                        )

            data = bytes(chunks)
            _check_image(data)
            return data

    raise AdapterError(
        "写真URLのリダイレクト回数が多すぎます"
    )


def _atomic_write(path, data):
    """途中で失敗しても壊れたファイルを残さない。"""
    os.makedirs(
        os.path.dirname(os.path.abspath(path)),
        exist_ok=True,
    )
    temporary = f"{path}.{uuid.uuid4().hex}.tmp"

    try:
        with open(temporary, "wb") as fp:
            fp.write(data)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.remove(temporary)


def _atomic_image_save(im, path):
    os.makedirs(
        os.path.dirname(os.path.abspath(path)),
        exist_ok=True,
    )
    temporary = f"{path}.{uuid.uuid4().hex}.tmp"

    try:
        im.save(temporary, format="JPEG", quality=92)
        with open(temporary, "rb") as fp:
            _check_image(fp.read())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.remove(temporary)


def download(url, dest, timeout=30):
    """通信エラー等を最大3回再試行する。"""
    _https_url(url)
    last_error = None

    for attempt in range(
        1, MAX_DOWNLOAD_ATTEMPTS + 1
    ):
        try:
            data = _read_photo(url, timeout)
            _atomic_write(dest, data)
            return dest

        except AdapterError as exc:
            if (
                "破損" not in str(exc)
                and "読み込めません" not in str(exc)
            ):
                raise
            last_error = exc

        except (
            requests.RequestException,
            TransientPhotoError,
        ) as exc:
            last_error = exc

        if attempt < MAX_DOWNLOAD_ATTEMPTS:
            time.sleep(0.5 * attempt)

    raise AdapterError(
        f"写真取得に{MAX_DOWNLOAD_ATTEMPTS}回失敗しました"
        f"（{type(last_error).__name__}）"
    ) from last_error


class PhotoStore:
    """写真と切り出し設定を識別してキャッシュする。"""

    def __init__(self, cache_dir):
        self.dir = cache_dir
        os.makedirs(self.dir, exist_ok=True)

    def path_for(self, kind, key_material):
        digest = hashlib.sha256(
            key_material.encode("utf-8")
        ).hexdigest()[:32]
        return os.path.join(
            self.dir,
            f"{kind}_{digest}.jpg",
        )

    def _valid_cache(self, path):
        if not os.path.exists(path):
            return False

        try:
            if os.path.getsize(path) > MAX_PHOTO_BYTES:
                raise AdapterError(
                    "キャッシュが容量超過です"
                )
            with open(path, "rb") as fp:
                _check_image(fp.read())
            return True

        except (OSError, AdapterError):
            try:
                os.remove(path)
            except OSError:
                pass
            return False

    def fetch_raw(self, url):
        path = self.path_for("raw", url)

        if not self._valid_cache(path):
            download(url, path)

        return path

    def fetch_legacy_cropped(
        self, url, muse_id, crops
    ):
        info = crops["items"].get(muse_id)

        if (
            not isinstance(info, dict)
            or info.get("placeholder")
        ):
            raise AdapterError(
                "従来写真の切り出し設定が見つかりません"
            )

        settings = json.dumps(
            info,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )

        path = self.path_for(
            "crop",
            f"{url}|{muse_id}|{settings}",
        )

        if self._valid_cache(path):
            return path

        original = self.fetch_raw(url)

        try:
            with Image.open(original) as im:
                image = im.convert("RGB")

            x, y, w, h = info["crop"]
            values = (x, y, w, h)

            if (
                not all(
                    isinstance(v, int)
                    and not isinstance(v, bool)
                    for v in values
                )
                or x < 0
                or y < 0
                or w <= 0
                or h <= 0
                or x + w > image.width
                or y + h > image.height
            ):
                raise AdapterError(
                    f"切り出し設定が画像サイズを"
                    f"超えています: {muse_id}"
                )

            cropped = make_board.apply_crop(
                image, info
            )
            _atomic_image_save(cropped, path)
            return path

        except AdapterError:
            raise
        except (
            OSError,
            ValueError,
            KeyError,
            TypeError,
        ) as exc:
            raise AdapterError(
                f"従来写真の切り出しに失敗: {muse_id}"
            ) from exc

    def placeholder(
        self,
        aspect,
        label="写真準備中",
    ):
        path = self.path_for(
            "ph", f"{aspect}|{label}"
        )

        if not self._valid_cache(path):
            panel = make_board.placeholder_panel(
                aspect, label
            )
            _atomic_image_save(panel, path)

        return path


def resolve_photo(item, muse_id, store, crops):
    """
    戻り値:
    (写真パス, r2 / legacy / placeholder)
    """
    if item.get("image_key"):
        url = item.get("image_url")
        if not url:
            raise AdapterError(
                "image_keyに対応するimage_urlがありません: "
                f"{item.get('product_id')}"
            )
        return store.fetch_raw(url), "r2"

    if muse_id and item.get("legacy_image_url"):
        info = crops["items"].get(muse_id)

        if (
            isinstance(info, dict)
            and info.get("placeholder")
        ):
            return (
                store.placeholder(
                    info.get(
                        "aspect",
                        DEFAULT_PLACEHOLDER_ASPECT,
                    ),
                    info.get(
                        "label", "写真準備中"
                    ),
                ),
                "placeholder",
            )

        if isinstance(info, dict):
            return (
                store.fetch_legacy_cropped(
                    item["legacy_image_url"],
                    muse_id,
                    crops,
                ),
                "legacy",
            )

    return (
        store.placeholder(
            DEFAULT_PLACEHOLDER_ASPECT
        ),
        "placeholder",
    )


def convert(today, store, crops, mapping):
    """販売データを描画用specに変換する。"""
    items_in = today.get("items")

    if not isinstance(items_in, list):
        raise AdapterError(
            "itemsが配列ではありません"
        )

    if not 1 <= len(items_in) <= MAX_ITEMS:
        raise AdapterError(
            f"items must be 1..{MAX_ITEMS} "
            f"(got {len(items_in)})"
        )

    by_worker_id = {}

    for entry in mapping.get("mappings", []):
        worker_id = entry["worker_id"]

        if worker_id in by_worker_id:
            raise AdapterError(
                "重複した商品IDの対応定義があります: "
                f"{worker_id}"
            )

        by_worker_id[worker_id] = entry

    ordered = sorted(
        items_in,
        key=lambda x: (
            x.get("sort_order") or 0,
            str(x.get("product_id")),
        ),
    )

    spec_items = []
    sources = []
    seen = set()

    for item in ordered:
        pid = item.get("product_id")

        if not isinstance(pid, str) or not pid:
            raise AdapterError(
                "product_idがないitemがあります"
            )

        if pid in seen:
            raise AdapterError(
                f"商品IDが重複しています: {pid}"
            )

        seen.add(pid)

        status = STATUS_MAP.get(
            item.get("status")
        )
        if status is None:
            raise AdapterError(
                f"unknown status: {item.get('status')} "
                f"(product_id={pid})"
            )

        category = CATEGORY_MAP.get(
            item.get("category")
        )
        if category is None:
            raise AdapterError(
                f"unknown category: {item.get('category')} "
                f"(product_id={pid})"
            )

        name = (
            item.get("name") or ""
        ).strip()

        if not name:
            raise AdapterError(
                f"nameが空です (product_id={pid})"
            )

        entry = by_worker_id.get(pid)
        muse_id = (
            entry["muse_id"] if entry else None
        )

        photo_path, source = resolve_photo(
            item, muse_id, store, crops
        )

        with Image.open(photo_path) as im:
            width, height = im.size

        breaks = (
            make_board.NAME_LINES.get(muse_id)
            if muse_id
            else None
        )

        spec_items.append({
            "id": pid,
            "status": status,
            "name": name,
            "category": category,
            "photo": photo_path,
            "aspect": height / width,
            "breaks": breaks,
        })

        sources.append({
            "product_id": pid,
            "muse_id": muse_id,
            "photo": source,
        })

    now = datetime.now(JST)

    return {
        "datetime": now.strftime(
            "%Y-%m-%dT%H:%M"
        ),
        "items": spec_items,
    }, sources


def generate(
    today,
    out_path,
    cache_dir=None,
    base_dir=BASE_DIR,
):
    """販売データから画像を生成する。"""
    crops = load_json(
        os.path.join(base_dir, "crops.json")
    )
    mapping = load_json(
        os.path.join(base_dir, "id_mapping.json")
    )

    store = PhotoStore(
        cache_dir
        or os.path.join(
            base_dir,
            "runtime",
            "photo_cache",
        )
    )

    spec, sources = convert(
        today, store, crops, mapping
    )

    spec_path = out_path + ".spec.json"

    os.makedirs(
        os.path.dirname(
            os.path.abspath(out_path)
        ),
        exist_ok=True,
    )

    with open(
        spec_path,
        "w",
        encoding="utf-8",
    ) as fp:
        json.dump(
            spec,
            fp,
            ensure_ascii=False,
            indent=1,
        )

    make_board.build(spec, out_path)

    return {
        "out": out_path,
        "spec": spec_path,
        "count": len(spec["items"]),
        "sources": sources,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()

    parser.add_argument(
        "--today",
        required=True,
        help="/muse/today の応答JSONファイル",
    )
    parser.add_argument(
        "--out",
        required=True,
    )
    parser.add_argument(
        "--cache-dir",
        default=None,
    )

    args = parser.parse_args()

    try:
        result = generate(
            load_json(args.today),
            args.out,
            args.cache_dir,
        )
    except (
        AdapterError,
        OSError,
        ValueError,
    ) as exc:
        sys.exit(f"adapter error: {exc}")

    print(json.dumps(
        result,
        ensure_ascii=False,
    ))
