
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
おにぎり屋かなたけ「本日の販売状況ボード」生成スクリプト（カードレイアウト版）

使い方:
  python3 make_board.py --spec order.json --out board.jpg

order.json の形式:
  {
    "datetime": "2026-10-25T12:30",
    "items": [
      {"id": "komatsuna_salmon_cheese", "status": "on_sale"},
      {"id": "ooba_miso", "status": "sold_out"}
    ]
  }
  status は on_sale（販売中） / low（残りわずか） / sold_out（売り切れ）。

  API連携用（adapter.py が生成）: items の各要素に name / category / photo
  （用意済み写真ファイルのパス）/ aspect / breaks を付けると、商品マスタに
  無い商品でも同じレイアウトで描画できる。photo が指す画像は「そのまま
  カードの形になる写真」として扱い、切り出しはしない（切り出しが必要な
  従来商品は adapter 側で crops.json を適用してから渡す）。

写真の切り出し範囲は crops.json（同フォルダ）で管理する。
写真ファイルは assets/ フォルダに置く（無ければ source_base から取得する）。
曜日は datetime から自動計算する（手入力しない）。

レイアウトルール（試作仕様 v5）:
  - 1080x1920、クリーム背景、こげ茶文字、Noto Sans CJK JP Bold
  - カード = 写真エリア + 名前エリア。写真エリアの高さは段ごとに、その段で最も
    縦長な写真に合わせる（上限は縦横比1.0）。上限より縦長な写真は高さをエリアに
    合わせて幅を絞って中央に置くので、段の他のカードを引き伸ばさない。
    写真は縦横比を維持し、切り落とさない。同じ段のカードは高さをそろえる
  - 名前エリアは名前の行数分だけ（余白埋めのために拡張しない）
  - カテゴリ見出しは2カテゴリ以上ある日だけ表示
  - 列数: 1〜2品=1列（2品は縦2段・幅約1000px）/ 3〜4品=2列 /
    5〜8品=3列 / 9〜12品=4列 / 13〜16品=5列。
    端数の行は中央寄せ
  - 縦の余白はカードの外側（行間と見出し間）へ均等に配分し、残りは上下均等
  - 商品名は文字サイズをそろえ、1行に収まらなければ商品マスタの指定位置で折り返す
  - スタンプは写真エリアの内側に収め、商品名を隠さない
  - 16品まで1枚に収まるようカードを自動で縮小
  - 売り切れ: 写真を淡くグレー寄りに + 赤スタンプ /
    残りわずか: 橙スタンプ / 販売中: スタンプなし
  - 商品の追加は PRODUCTS に1件足すだけ（写真の切り出しは crops.json、
    写真が無い商品は crops.json で placeholder を指定すると仮パネルになる）
"""
import argparse, json, math, os, sys, urllib.request
from datetime import datetime
from PIL import Image, ImageDraw, ImageFont, ImageEnhance, ImageFilter

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FONT = "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"
W, H = 1080, 1920
BG = (247, 242, 231)
BROWN = (74, 52, 38)
SUB = (130, 110, 90)
RED = (206, 52, 38)
ORANGE = (224, 122, 26)
WEEKDAYS = ["月", "火", "水", "木", "金", "土", "日"]

# 商品マスタ（表示順 = この順）
# 4番目の要素は商品名の折り返し位置（言葉の切れ目）。
# 1行に収まる日は使われず1行で出る。
# None の商品は自動でバランスよく折り返す。
PRODUCTS = [
    ("komatsuna_salmon_cheese", "小松菜と炙り鮭チーズ", "おにぎり", ["小松菜と", "炙り鮭チーズ"]),
    ("yamawasabi_cream_cheese", "山わさびとクリームチーズ", "おにぎり", ["山わさびと", "クリームチーズ"]),
    ("double_konbu", "ダブル昆布", "おにぎり", None),
    ("ume_kinpira_gobo", "梅きんぴらごぼう", "おにぎり", ["梅きんぴら", "ごぼう"]),
    ("ooba_miso", "大葉みそ", "おにぎり", None),
    ("jagaimo_curry_soboro", "じゃがいもとカレーそぼろ", "おにぎり", ["じゃがいもと", "カレーそぼろ"]),
    ("gentei_onigiri", "季節の限定おにぎり", "おにぎり", ["季節の限定", "おにぎり"]),
    ("aji_fry_noriben", "アジフライ海苔弁当", "お弁当", ["アジフライ", "海苔弁当"]),
    ("ebi_fry_noriben", "エビフライ海苔弁当", "お弁当", ["エビフライ", "海苔弁当"]),
    ("karaage_noriben", "からあげ海苔弁当", "お弁当", ["からあげ", "海苔弁当"]),
    ("shacho_noriben", "社長の海苔弁", "お弁当", ["社長の", "海苔弁"]),
    ("tonjiru", "本日の限定みそ汁", "その他", ["本日の限定", "みそ汁"]),
    ("genmai_dango", "女神の玄米だんご", "その他", ["女神の", "玄米だんご"]),
    ("munekara", "むねから", "その他", None),
    ("pori_chabin", "ポリ茶瓶", "その他", None),
    ("megami_no_hohoemi", "女神のほほえみ", "その他", ["女神の", "ほほえみ"]),
]
MASTER = {pid: (name, cat) for pid, name, cat, _ in PRODUCTS}
NAME_LINES = {pid: lines for pid, _, _, lines in PRODUCTS}
ORDER = {pid: i for i, (pid, *_rest) in enumerate(PRODUCTS)}
CATEGORY_ORDER = ["おにぎり", "お弁当", "その他"]


def font(sz):
    return ImageFont.truetype(FONT, int(sz))


def text_w(draw, s, f):
    bb = draw.textbbox((0, 0), s, font=f)
    return bb[2] - bb[0]


def placeholder_panel(aspect=0.75, label="写真準備中"):
    """写真がない商品の仮パネル。"""
    w = 1000
    h = int(w * aspect)
    panel = Image.new("RGB", (w, h), (250, 247, 240))
    pd = ImageDraw.Draw(panel)
    pd.rounded_rectangle(
        [26, 26, w - 26, h - 26],
        radius=24,
        outline=(196, 180, 152),
        width=5,
    )
    f = font(72)
    pd.text(
        ((w - text_w(pd, label, f)) / 2, (h - 72) / 2),
        label,
        font=f,
        fill=SUB,
    )
    return panel


def apply_crop(im, info):
    """whiteout（装飾消し）と切り出しを適用する。"""
    if info.get("whiteout"):
        wd = ImageDraw.Draw(im)
        for poly in info["whiteout"]:
            wd.polygon(
                [tuple(p) for p in poly],
                fill=(255, 255, 255),
            )
    x, y, w, h = info["crop"]
    return im.crop((x, y, x + w, y + h))


def load_photo(pid, crops):
    info = crops["items"][pid]
    if info.get("placeholder"):
        return placeholder_panel(
            info.get("aspect", 0.75),
            info.get("label", "写真準備中"),
        )
    path = os.path.join(BASE_DIR, "assets", info["file"])
    if not os.path.exists(path):
        os.makedirs(
            os.path.join(BASE_DIR, "assets"),
            exist_ok=True,
        )
        urllib.request.urlretrieve(
            crops["source_base"] + info["file"],
            path,
        )
    im = Image.open(path).convert("RGB")
    return apply_crop(im, info)


def wrap_lines(draw, name, f, max_w):
    """商品名を最大2行に折り返す。"""
    if text_w(draw, name, f) <= max_w:
        return [name]

    best = None
    for i in range(1, len(name)):
        a, b = name[:i], name[i:]
        wa = text_w(draw, a, f)
        wb = text_w(draw, b, f)
        if wa <= max_w and wb <= max_w:
            score = max(wa, wb)
            if (
                best is None
                or score < best[0] - 1
                or (
                    score <= best[0] + 1
                    and wa > best[2]
                )
            ):
                best = (score, [a, b], wa)
    if best:
        return best[1]

    mids = min(
        range(1, len(name)),
        key=lambda i: abs(
            text_w(draw, name[:i], f)
            - text_w(draw, name[i:], f)
        ),
    )
    return [name[:mids], name[mids:]]


def make_stamp(lines, color, diameter):
    d = int(diameter)
    S = d + 16
    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    dr = ImageDraw.Draw(layer)

    dr.ellipse(
        [8, 8, S - 8, S - 8],
        fill=(255, 255, 255, 235),
        outline=color + (255,),
        width=max(4, d // 16),
    )
    dr.ellipse(
        [
            d // 12 + 8,
            d // 12 + 8,
            S - d // 12 - 8,
            S - d // 12 - 8,
        ],
        outline=color + (255,),
        width=2,
    )

    fs = d * 0.30
    while fs > 10:
        f = font(fs)
        if all(
            text_w(dr, t, f) <= d * 0.78
            for t in lines
        ):
            break
        fs -= 2

    line_h = fs * 1.12
    y = S / 2 - line_h * len(lines) / 2

    for t in lines:
        f = font(fs)
        dr.text(
            ((S - text_w(dr, t, f)) / 2, y),
            t,
            font=f,
            fill=color + (255,),
        )
        y += line_h

    return layer.rotate(
        -12,
        resample=Image.BICUBIC,
        expand=True,
    )


def build(spec, out_path):
    with open(
        os.path.join(BASE_DIR, "crops.json"),
        encoding="utf-8",
    ) as fp:
        crops = json.load(fp)

    dt = datetime.fromisoformat(spec["datetime"])
    items = spec["items"]

    # API連携アイテムはspecの表示情報を使用する。
    spec_index = {
        it["id"]: i for i, it in enumerate(items)
    }
    resolved = {}

    for it in items:
        pid = it["id"]
        if it["status"] not in (
            "on_sale", "low", "sold_out"
        ):
            sys.exit(
                f"unknown status: {it['status']}"
            )

        if "name" in it and "category" in it:
            if not it.get("photo"):
                sys.exit(
                    f"photo file required for api item: {pid}"
                )
            resolved[pid] = {
                "name": it["name"],
                "cat": it["category"],
                "breaks": it.get("breaks"),
                "photo": it["photo"],
                "aspect": it.get("aspect"),
            }
        elif pid in MASTER:
            resolved[pid] = {
                "name": MASTER[pid][0],
                "cat": MASTER[pid][1],
                "breaks": NAME_LINES.get(pid),
                "photo": None,
                "aspect": None,
            }
        else:
            sys.exit(
                f"unknown product id: {pid}"
            )

    n = len(items)
    if n == 0 or n > 16:
        sys.exit("items must be 1..16")

    sections = []
    for cat in CATEGORY_ORDER:
        group = [
            it for it in items
            if resolved[it["id"]]["cat"] == cat
        ]
        group.sort(
            key=lambda it: (
                ORDER.get(it["id"], 1 << 30),
                spec_index[it["id"]],
            )
        )
        if group:
            sections.append((cat, group))

    show_headings = len(sections) >= 2

    cols = (
        1 if n <= 2
        else 2 if n <= 4
        else 3 if n <= 8
        else 4 if n <= 12
        else 5
    )
    margin_x = 36
    gap = 20
    vgap = 20
    grid_w = W - margin_x * 2
    heading_h = 74 if show_headings else 0
    section_gap = 34 if show_headings else 22
    content_top = 250
    content_bottom = 1770
    avail_h = content_bottom - content_top

    probe = ImageDraw.Draw(
        Image.new("RGB", (8, 8))
    )
    aspect = {}

    for it in items:
        pid = it["id"]
        if resolved[pid]["aspect"]:
            aspect[pid] = resolved[pid]["aspect"]
        else:
            info = crops["items"][pid]
            aspect[pid] = (
                info["aspect"]
                if info.get("placeholder")
                else info["crop"][3] / info["crop"][2]
            )

    sec_rows = [
        [
            group[i:i + cols]
            for i in range(0, len(group), cols)
        ]
        for _, group in sections
    ]

    def name_plan(card_w):
        fs = max(
            24,
            min(40, card_w * 0.118),
        )

        while fs > 14:
            f = font(fs)
            plan = {}
            ok = True

            for it in items:
                pid = it["id"]
                nm = resolved[pid]["name"]

                if text_w(
                    probe, nm, f
                ) <= card_w - 16:
                    plan[pid] = [nm]
                    continue

                manual = resolved[pid]["breaks"]
                if manual and all(
                    text_w(
                        probe, ln, f
                    ) <= card_w - 16
                    for ln in manual
                ):
                    plan[pid] = manual
                    continue

                lines = wrap_lines(
                    probe,
                    nm,
                    f,
                    card_w - 16,
                )

                if any(
                    text_w(
                        probe, ln, f
                    ) > card_w - 16
                    for ln in lines
                ):
                    ok = False
                    break

                plan[pid] = lines

            if ok:
                return fs, plan

            fs -= 2

        f = font(fs)
        plan = {
            it["id"]: wrap_lines(
                probe,
                resolved[it["id"]]["name"],
                f,
                card_w - 16,
            )
            for it in items
        }
        return fs, plan

    ASPECT_CAP = 1.0

    def compute(card_w):
        name_fs, plan = name_plan(card_w)
        name_h = int(
            max(
                len(plan[it["id"]])
                for it in items
            ) * name_fs * 1.18 + 18
        )

        row_plans = []
        total = 0

        for si, rows in enumerate(sec_rows):
            rps = []

            for row in rows:
                ph_area = int(
                    card_w * min(
                        max(
                            aspect[it["id"]]
                            for it in row
                        ),
                        ASPECT_CAP,
                    ) + 0.5
                )
                disp = {}

                for it in row:
                    a = aspect[it["id"]]

                    if a <= ASPECT_CAP:
                        disp[it["id"]] = (
                            int(card_w),
                            int(card_w * a + 0.5),
                        )
                    else:
                        disp[it["id"]] = (
                            int(ph_area / a + 0.5),
                            ph_area,
                        )

                rps.append((
                    row,
                    disp,
                    ph_area,
                    ph_area + name_h,
                ))

            row_plans.append(rps)

            total += (
                heading_h
                + sum(
                    rh for _, _, _, rh in rps
                )
                + (len(rps) - 1) * vgap
            )

            if si < len(sec_rows) - 1:
                total += section_gap

        return name_fs, plan, row_plans, total

    card_w = (
        grid_w - (cols - 1) * gap
    ) // cols

    if n == 2:
        card_w = min(card_w, 1000)

    name_fs, name_lines, row_plans, total = compute(
        card_w
    )

    while total > avail_h and card_w > 120:
        card_w -= 4
        name_fs, name_lines, row_plans, total = compute(
            card_w
        )

    while total < avail_h and (
        vgap < 170 or section_gap < 280
    ):
        prev = total
        vgap += 4
        section_gap += 4

        name_fs, name_lines, row_plans, total = compute(
            card_w
        )
        if total == prev:
            break

    while total > avail_h and section_gap > 34:
        section_gap -= 4
        name_fs, name_lines, row_plans, total = compute(
            card_w
        )

    while total > avail_h and vgap > 20:
        vgap -= 4
        name_fs, name_lines, row_plans, total = compute(
            card_w
        )

    # 影と本体を分けて描画
    cv = Image.new("RGB", (W, H), BG)
    dr = ImageDraw.Draw(cv)

    overlay = Image.new(
        "RGBA",
        (W, H),
        (0, 0, 0, 0),
    )
    odr = ImageDraw.Draw(overlay)

    title = "本日の販売状況"
    f = font(66)
    dr.text(
        (
            (W - text_w(dr, title, f)) / 2,
            72,
        ),
        title,
        font=f,
        fill=BROWN,
    )

    wd = WEEKDAYS[dt.weekday()]
    sub = (
        f"{dt.month}月{dt.day}日（{wd}）"
        f"{dt.hour}:{dt.minute:02d} 時点"
    )
    f2 = font(38)
    dr.text(
        (
            (W - text_w(dr, sub, f2)) / 2,
            162,
        ),
        sub,
        font=f2,
        fill=SUB,
    )

    foot = "おにぎり屋かなたけ"
    f3 = font(44)
    dr.text(
        (
            (W - text_w(dr, foot, f3)) / 2,
            1816,
        ),
        foot,
        font=f3,
        fill=BROWN,
    )

    y = content_top + (
        avail_h - total
    ) // 2
    cards_xy = []

    for (cat, group), rps in zip(
        sections, row_plans
    ):
        if show_headings:
            fh = font(46)
            dr.text(
                (
                    margin_x + 4,
                    y + 2,
                ),
                cat,
                font=fh,
                fill=BROWN,
            )
            dr.line(
                [
                    margin_x + 4,
                    y + heading_h - 8,
                    margin_x + grid_w - 4,
                    y + heading_h - 8,
                ],
                fill=(210, 195, 170),
                width=3,
            )
            y += heading_h

        for ri, (
            row,
            disp,
            ph_area,
            row_h,
        ) in enumerate(rps):
            row_w = (
                len(row) * card_w
                + (len(row) - 1) * gap
            )
            x = margin_x + (
                grid_w - row_w
            ) // 2

            for it in row:
                dw, dh = disp[it["id"]]
                cards_xy.append((
                    x,
                    y,
                    it,
                    dw,
                    dh,
                    ph_area,
                    row_h,
                ))
                x += card_w + gap

            y += row_h

            if ri < len(rps) - 1:
                y += vgap

        y += section_gap

    # スタンプの直径を全カードで統一
    stamp_d = None
    caps = []

    for rps in row_plans:
        for row, disp, ph_area, row_h in rps:
            for it in row:
                if it["status"] in (
                    "sold_out", "low"
                ):
                    dw_i, dh_i = disp[it["id"]]
                    caps.append(
                        min(
                            dw_i,
                            (dh_i - 12) * 0.92,
                        )
                    )

    if caps:
        stamp_d = int(
            max(
                40,
                min(
                    card_w * 0.68,
                    card_w - 20,
                    min(caps),
                ),
            )
        )

    # カードの影
    for (
        x, y, it, dw, dh, ph_area, row_h
    ) in cards_xy:
        odr.rounded_rectangle(
            [
                x + 3,
                y + 5,
                x + card_w + 3,
                y + row_h + 5,
            ],
            radius=18,
            fill=(0, 0, 0, 36),
        )

    shadow = overlay.filter(
        ImageFilter.GaussianBlur(4)
    )
    cv = Image.alpha_composite(
        cv.convert("RGBA"),
        shadow,
    ).convert("RGB")
    dr = ImageDraw.Draw(cv)

    stamp_jobs = []

    for (
        x, y, it, dw, dh, ph_area, row_h
    ) in cards_xy:
        pid = it["id"]

        dr.rounded_rectangle(
            [
                x,
                y,
                x + card_w,
                y + row_h,
            ],
            radius=18,
            fill=(255, 255, 255),
        )

        if resolved[pid]["photo"]:
            photo = Image.open(
                resolved[pid]["photo"]
            ).convert("RGB")
        else:
            photo = load_photo(pid, crops)

        if it["status"] == "sold_out":
            photo = ImageEnhance.Brightness(
                ImageEnhance.Color(
                    photo
                ).enhance(0.22)
            ).enhance(0.94)

        photo = photo.resize(
            (int(dw), int(dh)),
            Image.LANCZOS,
        )

        mask = Image.new(
            "L",
            (int(dw), int(dh)),
            0,
        )
        md = ImageDraw.Draw(mask)

        px = x + (
            card_w - dw
        ) // 2
        py = y + (
            ph_area - dh
        ) // 2

        if py == y:
            md.rounded_rectangle(
                [0, 0, dw, dh + 18],
                radius=18,
                fill=255,
            )
        else:
            md.rounded_rectangle(
                [0, 0, dw, dh],
                radius=18,
                fill=255,
            )

        cv.paste(
            photo,
            (px, py),
            mask,
        )

        nf = font(name_fs)
        lines = name_lines[pid]
        text_h = (
            len(lines) * name_fs * 1.18
        )

        ny = (
            y + ph_area
            + max(
                6,
                (
                    row_h
                    - ph_area
                    - text_h
                ) / 2,
            )
        )

        for ln in lines:
            dr.text(
                (
                    x + (
                        card_w - text_w(
                            dr, ln, nf
                        )
                    ) / 2,
                    ny,
                ),
                ln,
                font=nf,
                fill=BROWN,
            )
            ny += name_fs * 1.18

        if it["status"] in (
            "sold_out", "low"
        ):
            if it["status"] == "sold_out":
                stamp = make_stamp(
                    ["売り切れ"],
                    RED,
                    stamp_d,
                )
            else:
                stamp = make_stamp(
                    ["残り", "わずか"],
                    ORANGE,
                    stamp_d,
                )

            sx = max(
                x + 2,
                int(
                    px + dw
                    - stamp.size[0]
                    - 4
                ),
            )

            stamp_jobs.append((
                stamp,
                sx,
                int(py + 4),
            ))

    # スタンプは全カード描画後に重ねる
    for stamp, sx, sy in stamp_jobs:
        cv.paste(
            stamp,
            (sx, sy),
            stamp,
        )

    cv.save(
        out_path,
        quality=90,
    )
    print(
        f"saved {out_path} "
        f"items={n} "
        f"cols={cols} "
        f"card_w={card_w}"
    )


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--spec",
        required=True,
    )
    ap.add_argument(
        "--out",
        required=True,
    )
    args = ap.parse_args()

    with open(
        args.spec,
        encoding="utf-8",
    ) as fp:
        spec = json.load(fp)

    build(spec, args.out)
