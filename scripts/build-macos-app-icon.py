#!/usr/bin/env python3
#* 1024×1024 для Tauri/Dock: светлая плашка как у оригинального app-icon + знак без белого поля по краям.
from __future__ import annotations

import sys
from collections import deque
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
LOGO_PATH = ROOT / "web-app" / "public" / "images" / "app-icon.png"
OUT_PATH = ROOT / "src-tauri" / "icons" / "icon.png"
SIZE = 1024
#? Прозрачный отступ от края холста (~шаблон Apple / размер «плитки» в Dock)
SAFE_INSET_FRAC = 0.115
#? Скругление плашки — доля стороны внутреннего квадрата
RADIUS_FRAC = 0.223
#? Светлая плашка — чёрный знак читается как в исходном PNG (не тёмный «квадрат в квадрате»)
PLATE_RGBA = (252, 252, 253, 255)
#? Доля стороны плашки под глиф после обрезки
GLYPH_IN_PLATE_FRAC = 0.88
#? Порог «похож на фон углов» для заливки от краёв (белое + мягкая тень у рамки)
EDGE_BG_TOLERANCE = 34


def corner_ref_rgb(im: Image.Image) -> tuple[int, int, int]:
    #* Опорный цвет фона — среднее по углам (у app-icon это белый).
    w, h = im.size
    px = im.load()
    corners = [
        px[0, 0][:3],
        px[w - 1, 0][:3],
        px[0, h - 1][:3],
        px[w - 1, h - 1][:3],
    ]
    return (
        sum(c[0] for c in corners) // 4,
        sum(c[1] for c in corners) // 4,
        sum(c[2] for c in corners) // 4,
    )


def rgba_remove_edge_connected_background(im: Image.Image, tolerance: int) -> Image.Image:
    #* Убирает только фон, связанный с краем кадра — внутренности чёрного знака не трогаем.
    w, h = im.size
    px = im.load()
    br, bg, bb = corner_ref_rgb(im)

    def matches_bg(r: int, g: int, b: int) -> bool:
        return (
            abs(r - br) <= tolerance
            and abs(g - bg) <= tolerance
            and abs(b - bb) <= tolerance
        )

    visited = [[False] * w for _ in range(h)]
    q: deque[tuple[int, int]] = deque()

    def try_seed(x: int, y: int) -> None:
        if not (0 <= x < w and 0 <= y < h) or visited[y][x]:
            return
        r, g, b, _a = px[x, y]
        if matches_bg(r, g, b):
            visited[y][x] = True
            q.append((x, y))

    for x in range(w):
        try_seed(x, 0)
        try_seed(x, h - 1)
    for y in range(h):
        try_seed(0, y)
        try_seed(w - 1, y)

    while q:
        x, y = q.popleft()
        for dx, dy in ((0, 1), (0, -1), (1, 0), (-1, 0)):
            nx, ny = x + dx, y + dy
            if not (0 <= nx < w and 0 <= ny < h) or visited[ny][nx]:
                continue
            r, g, b, _a = px[nx, ny]
            if matches_bg(r, g, b):
                visited[ny][nx] = True
                q.append((nx, ny))

    out = im.copy()
    opx = out.load()
    for y in range(h):
        for x in range(w):
            if visited[y][x]:
                r, g, b, _a = opx[x, y]
                opx[x, y] = (r, g, b, 0)
    return out


def ink_weighted_centroid(im: Image.Image) -> tuple[float, float]:
    #* Центр тяжести тёмного знака без лёгкой тени (bbox смещён вниз-вправо из‑за тени).
    w, h = im.size
    px = im.load()
    sx, sy, wsum = 0.0, 0.0, 0.0
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a < 12:
                continue
            darkness = (255.0 - max(r, g, b)) / 255.0
            if darkness < 0.28:
                continue
            wt = (a / 255.0) * darkness
            sx += x * wt
            sy += y * wt
            wsum += wt
    if wsum < 1e-6:
        return (w / 2.0, h / 2.0)
    return (sx / wsum, sy / wsum)


def main() -> None:
    if not LOGO_PATH.is_file():
        print(f"Missing {LOGO_PATH}", file=sys.stderr)
        sys.exit(1)

    inset = max(1, int(SIZE * SAFE_INSET_FRAC))
    x1, y1 = inset, inset
    x2, y2 = SIZE - 1 - inset, SIZE - 1 - inset
    plate_side = x2 - x1 + 1
    radius = max(1, int(plate_side * RADIUS_FRAC))

    logo = Image.open(LOGO_PATH).convert("RGBA")
    logo = rgba_remove_edge_connected_background(logo, EDGE_BG_TOLERANCE)
    bbox = logo.getbbox()
    if not bbox:
        print("Logo became empty after background removal", file=sys.stderr)
        sys.exit(1)
    logo = logo.crop(bbox)

    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle((x1, y1, x2, y2), radius=radius, fill=PLATE_RGBA)

    gmax = max(1, int(plate_side * GLYPH_IN_PLATE_FRAC))
    gw, gh = logo.size
    scale = min(gmax / gw, gmax / gh)
    nw, nh = max(1, int(gw * scale)), max(1, int(gh * scale))
    scaled = logo.resize((nw, nh), Image.Resampling.LANCZOS)

    #? Совмещаем центр «чернил», а не центр прямоугольника с тенью — иначе звезда визуально уезжает.
    cx, cy = ink_weighted_centroid(scaled)
    ox = int(round(SIZE / 2 - cx))
    oy = int(round(SIZE / 2 - cy))
    canvas.alpha_composite(scaled, (ox, oy))

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(OUT_PATH, "PNG")
    print(f"Wrote {OUT_PATH} (plate {plate_side}px, inset {inset}px)")


if __name__ == "__main__":
    main()
