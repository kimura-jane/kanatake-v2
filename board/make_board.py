
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
おにぎり屋かなたけ・販売状況画像
テーマ：おにぎりでえがお

出力は1080x1920のJPEG。商品は1～16件まで対応。
adapter.py が使用する以下の公開APIを維持する：
    NAME_LINES, apply_crop(), placeholder_panel(), build()
コマンド例：python3 make_board.py --spec spec.json --out board.jpg
"""
import argparse
import io
import json
import math
import os
import random
import sys
import urllib.request
from datetime import datetime
from PIL import Image, ImageDraw, ImageEnhance, ImageFont

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
W, H = 1080, 1920
FONT_PATH = '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc'
HAND_FONT_PATH = os.path.join(BASE_DIR, 'fonts', 'Yomogi-Regular.ttf')
HAND_FONT_URL = 'https://raw.githubusercontent.com/google/fonts/main/ofl/yomogi/Yomogi-Regular.ttf'
_HAND_FONT_READY = None
PAPER = (255, 249, 234)
WHITE = (255, 253, 247)
BROWN = (83, 57, 39)
MUTED = (114, 91, 69)
LINE = (230, 204, 164)
ORANGE = (222, 130, 55)
GREEN = (115, 140, 75)
RED = (188, 62, 55)
WEEKDAYS = ['月', '火', '水', '木', '金', '土', '日']
CATEGORY_ORDER = ['おにぎり', 'お弁当', 'その他']
CATEGORY_COLORS = {
    'おにぎり': GREEN,
    'お弁当': ORANGE,
    'その他': (153, 128, 78),
}

PRODUCTS = [
    ('komatsuna_salmon_cheese', '小松菜と炙り鮭チーズ', 'おにぎり', ['小松菜と', '炙り鮭チーズ']),
    ('yamawasabi_cream_cheese', '山わさびとクリームチーズ', 'おにぎり', ['山わさびと', 'クリームチーズ']),
    ('double_konbu', 'ダブル昆布', 'おにぎり', None),
    ('ume_kinpira_gobo', '梅きんぴらごぼう', 'おにぎり', ['梅きんぴら', 'ごぼう']),
    ('ooba_miso', '大葉みそ', 'おにぎり', None),
    ('jagaimo_curry_soboro', 'じゃがいもとカレーそぼろ', 'おにぎり', ['じゃがいもと', 'カレーそぼろ']),
    ('gentei_onigiri', '季節の限定おにぎり', 'おにぎり', ['季節の限定', 'おにぎり']),
    ('aji_fry_noriben', 'アジフライ海苔弁当', 'お弁当', ['アジフライ', '海苔弁当']),
    ('ebi_fry_noriben', 'エビフライ海苔弁当', 'お弁当', ['エビフライ', '海苔弁当']),
    ('karaage_noriben', 'からあげ海苔弁当', 'お弁当', ['からあげ', '海苔弁当']),
    ('shacho_noriben', '社長の海苔弁', 'お弁当', ['社長の', '海苔弁']),
    ('tonjiru', '本日の限定みそ汁', 'その他', ['本日の限定', 'みそ汁']),
    ('genmai_dango', '女神の玄米だんご', 'その他', ['女神の', '玄米だんご']),
    ('munekara', 'むねから', 'その他', None),
    ('pori_chabin', 'ポリ茶瓶', 'その他', None),
    ('megami_no_hohoemi', '女神のほほえみ', 'その他', ['女神の', 'ほほえみ']),
]
MASTER = {pid: (name, category) for pid, name, category, _ in PRODUCTS}
NAME_LINES = {pid: breaks for pid, _, _, breaks in PRODUCTS}
ORDER = {pid: i for i, (pid, *_rest) in enumerate(PRODUCTS)}


def hand_font_path():
    """Yomogiを実行時に取得する。取得できない場合は既存の日本語フォント。"""
    global _HAND_FONT_READY
    if _HAND_FONT_READY is not None:
        return _HAND_FONT_READY or FONT_PATH

    if os.path.isfile(HAND_FONT_PATH):
        try:
            ImageFont.truetype(HAND_FONT_PATH, 24)
            _HAND_FONT_READY = HAND_FONT_PATH
            return HAND_FONT_PATH
        except OSError:
            pass

    _HAND_FONT_READY = False
    try:
        with urllib.request.urlopen(HAND_FONT_URL, timeout=8) as response:
            data = response.read(6 * 1024 * 1024 + 1)
        if not (100_000 < len(data) <= 6 * 1024 * 1024):
            return FONT_PATH
        if data[:4] not in (b'\x00\x01\x00\x00', b'OTTO'):
            return FONT_PATH

        os.makedirs(os.path.dirname(HAND_FONT_PATH), exist_ok=True)
        temporary = HAND_FONT_PATH + '.tmp'
        with open(temporary, 'wb') as fp:
            fp.write(data)
        ImageFont.truetype(temporary, 24)
        os.replace(temporary, HAND_FONT_PATH)
        _HAND_FONT_READY = HAND_FONT_PATH
    except (OSError, ValueError) as exc:
        print('Yomogiフォント取得失敗（標準日本語フォントで続行）: '
              + type(exc).__name__, file=sys.stderr)
    return _HAND_FONT_READY or FONT_PATH


def font(size, hand=False):
    path = hand_font_path() if hand else FONT_PATH
    return ImageFont.truetype(path, max(12, int(size)))


def text_width(draw, text, f):
    box = draw.textbbox((0, 0), text, font=f)
    return box[2] - box[0]


def center_text(draw, text, y, f, fill, x0=0, x1=W):
    """実際の文字の外接矩形を基準に、上端と左右中央を揃える。"""
    bbox = draw.textbbox((0, 0), text, font=f)
    tw = bbox[2] - bbox[0]
    x = (x0 + x1 - tw) / 2 - bbox[0]
    draw.text((round(x), round(y - bbox[1])), text, font=f, fill=fill)


def center_text_in_box(draw, text, box, f, fill):
    """手書きフォントでも帯やバッジ内に上下左右中央に配置する。"""
    x0, y0, x1, y1 = box
    bbox = draw.textbbox((0, 0), text, font=f)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    x = (x0 + x1 - tw) / 2 - bbox[0]
    y = (y0 + y1 - th) / 2 - bbox[1]
    draw.text((round(x), round(y)), text, font=f, fill=fill)


def placeholder_panel(aspect=0.75, label='写真準備中'):
    """アダプターからも呼ばれる写真なし表示。"""
    aspect = float(aspect)
    w = 800
    h = max(100, min(1400, round(w * aspect)))
    img = Image.new('RGB', (w, h), (250, 245, 230))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((18, 18, w - 18, h - 18), radius=30,
                        outline=LINE, width=5)
    f = font(58)
    center_text(d, str(label), max(12, (h - 70) // 2), f, MUTED, 0, w)
    return img


def apply_crop(im, info):
    """旧写真のwhiteoutとcropに対応する。adapter.pyとの互換性を維持。"""
    if info.get('whiteout'):
        d = ImageDraw.Draw(im)
        for polygon in info['whiteout']:
            d.polygon([tuple(p) for p in polygon], fill=(255, 255, 255))
    x, y, w, h = info['crop']
    return im.crop((x, y, x + w, y + h))


def load_legacy_photo(pid, crops):
    info = crops['items'][pid]
    if info.get('placeholder'):
        return placeholder_panel(info.get('aspect', 0.75), info.get('label', '写真準備中'))
    file_path = os.path.join(BASE_DIR, 'assets', info['file'])
    if not os.path.isfile(file_path):
        os.makedirs(os.path.dirname(file_path), exist_ok=True)
        urllib.request.urlretrieve(crops['source_base'] + info['file'], file_path)
    with Image.open(file_path) as im:
        return apply_crop(im.convert('RGB'), info)


def load_mascot():
    """公式キャラのみ使用。取得失敗時は別キャラを作らず店名文字で表示する。"""
    paths = [
        os.path.join(BASE_DIR, 'assets', 'icon.png'),
        os.path.join(BASE_DIR, 'icon.png'),
    ]
    for path in paths:
        if os.path.isfile(path):
            try:
                with Image.open(path) as im:
                    return im.convert('RGBA')
            except OSError:
                pass
    url = 'https://raw.githubusercontent.com/kimura-jane/kanatae-app/main/icon.png'
    try:
        with urllib.request.urlopen(url, timeout=8) as response:
            content = response.read(3 * 1024 * 1024 + 1)
        if not content or len(content) > 3 * 1024 * 1024:
            return None
        with Image.open(io.BytesIO(content)) as im:
            im.load()
            return im.convert('RGBA')
    except (OSError, ValueError) as exc:
        print(f'公式キャラクターの取得を省略: {type(exc).__name__}', file=sys.stderr)
        return None


def draw_paper(d):
    d.rectangle((0, 0, W, H), fill=PAPER)
    rnd = random.Random(34)
    for _ in range(500):
        x, y = rnd.randrange(W), rnd.randrange(H)
        d.ellipse((x, y, x + 2, y + 2), fill=(249, 231, 202))
    for i in range(7):
        x = 35 + i * 46
        d.polygon([(x, 18), (x + 36, 18), (x + 18, 55)],
                  fill=[(238, 169, 119), (243, 201, 116), (176, 193, 130)][i % 3])
        x2 = W - 35 - i * 46
        d.polygon([(x2 - 36, 18), (x2, 18), (x2 - 18, 55)],
                  fill=[(238, 169, 119), (243, 201, 116), (176, 193, 130)][i % 3])


def paste_mascot(canvas, mascot):
    if mascot is None:
        return
    mascot.thumbnail((145, 145), Image.Resampling.LANCZOS)
    x, y = 46, 72
    canvas.paste(mascot, (x, y), mascot)


def draw_header(canvas, d, dt):
    mascot = load_mascot()
    paste_mascot(canvas, mascot)
    d.rounded_rectangle((210, 76, 1019, 136), radius=29,
                        fill=(255, 239, 205), outline=LINE, width=2)
    center_text_in_box(d, 'おにぎりでえがお',
                       (210, 76, 1019, 136), font(41, hand=True), BROWN)
    center_text(d, 'おにぎり屋かなたけ', 147, font(44, hand=True), BROWN, 120, W - 90)
    d.rounded_rectangle((109, 223, 971, 300), radius=38,
                        fill=(255, 228, 173))
    center_text_in_box(d, '本日の販売状況',
                       (109, 223, 971, 300), font(57, hand=True), BROWN)
    weekday = WEEKDAYS[dt.weekday()]
    label = f'{dt.month}月{dt.day}日（{weekday}） {dt.hour:02d}:{dt.minute:02d}時点'
    center_text(d, label, 306, font(33), MUTED)
    d.line([(202, 211), (883, 211)], fill=(234, 166, 77), width=6)


def draw_footer(d):
    d.line([(70, 1771), (1010, 1771)], fill=LINE, width=3)
    center_text(d, '手づくりのあたたかさを、みんなに。', 1794,
                font(34, hand=True), BROWN)
    center_text(d, 'おにぎり屋かなたけ', 1851, font(29), MUTED)
    d.ellipse((56, 1796, 72, 1812), fill=(233, 138, 83))
    d.ellipse((1008, 1796, 1024, 1812), fill=(134, 157, 94))


def wrap_name(d, name, f, max_width, manual=None):
    if text_width(d, name, f) <= max_width:
        return [name]
    if manual and ''.join(manual) == name and all(
        text_width(d, line, f) <= max_width for line in manual
    ):
        return manual
    lines = []
    current = ''
    for char in name:
        if current and text_width(d, current + char, f) > max_width:
            lines.append(current)
            current = char
        else:
            current += char
    if current:
        lines.append(current)
    return lines


def name_layout(d, text, max_width, max_height, preferred, manual):
    for size in range(preferred, 13, -2):
        f = font(size)
        lines = wrap_name(d, text, f, max_width, manual)
        height = len(lines) * (size + 5)
        if height <= max_height:
            return f, lines, size + 5
    # 非常に長い商品名は、見切れ防止のため末尾に省略記号を付ける。
    size = 14
    f = font(size)
    lines = wrap_name(d, text, f, max_width, manual)
    allowed = max(1, max_height // (size + 5))
    if len(lines) > allowed:
        lines = lines[:allowed]
        last = lines[-1]
        while last and text_width(d, last + '…', f) > max_width:
            last = last[:-1]
        lines[-1] = last + '…'
    return f, lines, size + 5


def rounded_photo(canvas, photo, area, sold_out):
    x, y, w, h = area
    if sold_out:
        photo = ImageEnhance.Color(photo).enhance(0.25)
        photo = ImageEnhance.Brightness(photo).enhance(1.06)
    panel = Image.new('RGB', (w, h), (252, 244, 227))
    photo.thumbnail((w, h), Image.Resampling.LANCZOS)
    panel.paste(photo, ((w - photo.width) // 2, (h - photo.height) // 2))
    mask = Image.new('L', (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, w - 1, h - 1),
                                           radius=min(18, h // 7), fill=255)
    canvas.paste(panel, (x, y), mask)


def draw_status(d, status, x, y, card_width):
    if status == 'on_sale':
        return
    label = '売り切れ' if status == 'sold_out' else '残りわずか'
    bg = RED if status == 'sold_out' else (223, 115, 32)
    size = max(17, min(25, int(card_width * 0.115)))
    f = font(size)
    tw = text_width(d, label, f)
    bw = min(card_width - 13, tw + 25)
    bh = size + 22
    bx = x + card_width - bw - 7
    by = y + 7
    d.rounded_rectangle((bx, by, bx + bw, by + bh), radius=bh // 2,
                        fill=bg, outline=WHITE, width=2)
    center_text_in_box(d, label, (bx, by, bx + bw, by + bh), f, WHITE)


def draw_card(canvas, d, x, y, w, h, record, crops, cols):
    d.rounded_rectangle((x + 4, y + 6, x + w + 4, y + h + 6),
                        radius=19, fill=(239, 222, 194))
    d.rounded_rectangle((x, y, x + w, y + h), radius=19,
                        fill=WHITE, outline=(239, 220, 190), width=2)
    picture_h = max(55, int(h * (0.64 if cols >= 4 else 0.69)))
    picture_h = min(picture_h, h - 55)
    picture_w = max(50, w - 16)
    try:
        if record['photo']:
            with Image.open(record['photo']) as im:
                photo = im.convert('RGB')
        else:
            photo = load_legacy_photo(record['id'], crops)
    except (OSError, KeyError, ValueError) as exc:
        raise RuntimeError(f"商品写真を取得できません: {record['name']}") from exc
    rounded_photo(canvas, photo, (x + 8, y + 8, picture_w, picture_h),
                  record['status'] == 'sold_out')
    label_y = y + 8 + picture_h + 8
    label_h = max(26, y + h - 8 - label_y)
    preferred = 26 if cols == 5 else 31 if cols == 4 else 35 if cols == 3 else 44
    f, lines, line_h = name_layout(d, record['name'], w - 18,
                                   label_h, preferred, record['breaks'])
    ink_h = max(d.textbbox((0, 0), line, font=f)[3] -
                d.textbbox((0, 0), line, font=f)[1] for line in lines)
    total_h = (len(lines) - 1) * line_h + ink_h
    name_y = label_y + max(0, (label_h - total_h) // 2)
    for text in lines:
        center_text(d, text, name_y, f, BROWN, x + 5, x + w - 5)
        name_y += line_h
    draw_status(d, record['status'], x, y, w)


def group_items(items):
    groups = []
    for category in CATEGORY_ORDER:
        part = [p for p in items if p['category'] == category]
        if part:
            groups.append((category, part))
    return groups


def build(spec, out_path):
    dt = datetime.fromisoformat(spec['datetime'])
    raw = spec['items']
    if not isinstance(raw, list) or not 1 <= len(raw) <= 16:
        raise ValueError('商品数は1～16件にしてください')

    crops_path = os.path.join(BASE_DIR, 'crops.json')
    with open(crops_path, encoding='utf-8') as handle:
        crops = json.load(handle)

    items = []
    for i, p in enumerate(raw):
        pid = p['id']
        status = p['status']
        if status not in ('on_sale', 'low', 'sold_out'):
            raise ValueError(f'不正な販売状態: {status}')
        if 'name' in p and 'category' in p:
            name = p['name']
            category = p['category']
            photo = p.get('photo')
            breaks = p.get('breaks')
            if not photo:
                raise ValueError(f'API商品に写真がありません: {pid}')
        elif pid in MASTER:
            name, category = MASTER[pid]
            photo = None
            breaks = NAME_LINES.get(pid)
        else:
            raise ValueError(f'商品IDが見つかりません: {pid}')
        if category not in CATEGORY_ORDER:
            raise ValueError(f'不正な商品カテゴリ: {category}')
        items.append(dict(id=pid, status=status, name=str(name), category=category,
                          photo=photo, breaks=breaks, sequence=i))

    # 従来マスタの並びと、APIが指定した順序を両立する。
    items.sort(key=lambda v: (CATEGORY_ORDER.index(v['category']),
                              ORDER.get(v['id'], 10**8), v['sequence']))
    grouped = group_items(items)
    n = len(items)
    cols = (1 if n <= 2 else 2 if n <= 4 else 3 if n <= 8
            else 4 if n <= 12 else 5)
    # 各カテゴリ2品なら2列にする。カードの左端が見出しと揃う。
    cols = min(cols, max(len(part) for _, part in grouped))
    gap_x = 14 if cols >= 4 else 18
    card_w = (W - 84 - (cols - 1) * gap_x) // cols
    if cols == 1:
        card_w = min(card_w, 850)

    rows_by_section = [math.ceil(len(part) / cols) for _, part in grouped]
    rows_count = sum(rows_by_section)
    heading_h = 59 if len(grouped) > 1 else 0
    section_gap = 23
    row_gap = 16
    usable_top, usable_bottom = 380, 1742
    section_headers = heading_h * len(grouped)
    gaps_h = row_gap * (rows_count - len(grouped))
    gaps_h += section_gap * (len(grouped) - 1)
    row_h = (usable_bottom - usable_top - section_headers - gaps_h) // rows_count
    if row_h < 145:
        raise ValueError('商品が表示可能な範囲を超えています')
    # 品数の少ない日は不自然に縦長のカードにしない。
    row_h = min(row_h, 540 if cols == 1 else 470)
    used_h = rows_count * row_h + section_headers + gaps_h

    cv = Image.new('RGB', (W, H), PAPER)
    d = ImageDraw.Draw(cv)
    draw_paper(d)
    draw_header(cv, d, dt)
    draw_footer(d)

    y = usable_top + max(0, (usable_bottom - usable_top - used_h) // 2)
    for category, part in grouped:
        if heading_h:
            color = CATEGORY_COLORS[category]
            d.rounded_rectangle((42, y + 4, 342, y + 54),
                                radius=23, fill=color)
            center_text_in_box(d, category, (42, y + 4, 342, y + 54),
                               font(39, hand=True), WHITE)
            d.line((360, y + 41, W - 46, y + 41), fill=LINE, width=3)
            y += heading_h
        # 5品+1品のような片寄りを避け、各段をなるべく均等にする。
        row_count = math.ceil(len(part) / cols)
        base_count, extra = divmod(len(part), row_count)
        sizes = [base_count + (1 if i < extra else 0)
                 for i in range(row_count)]
        rows = []
        cursor = 0
        for size in sizes:
            rows.append(part[cursor:cursor + size])
            cursor += size
        for ri, row in enumerate(rows):
            width = len(row) * card_w + (len(row) - 1) * gap_x
            left = (W - width) // 2
            for i, rec in enumerate(row):
                draw_card(cv, d, left + i * (card_w + gap_x), y,
                          card_w, row_h, rec, crops, cols)
            y += row_h
            if ri < len(rows) - 1:
                y += row_gap
        if category != grouped[-1][0]:
            y += section_gap

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    cv.save(out_path, format='JPEG', quality=89, optimize=True)
    print(f'saved {out_path}: items={n}, cols={cols}, size={W}x{H}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--spec', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    with open(args.spec, encoding='utf-8') as handle:
        build(json.load(handle), args.out)
