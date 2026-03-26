#!/usr/bin/env python3
#* 1024×1024 для tauri: поле по краю (как у системных иконок) + плашка внутри safe area + крупный знак.
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
LOGO_PATH = ROOT / "web-app" / "public" / "images" / "atomic-chat-logo.png"
OUT_PATH = ROOT / "src-tauri" / "icons" / "icon.png"
SIZE = 1024
#? Прозрачный отступ от края холста (~шаблон Apple / размер «плитки» в Dock рядом с системными)
SAFE_INSET_FRAC = 0.115
#? Скругление плашки — доля стороны именно внутреннего квадрата
RADIUS_FRAC = 0.223
PLATE_RGBA = (44, 44, 46, 255)
#? Глиф занимает долю стороны *внутренней плашки* (крупнее знак, плашка уже по safe area)
GLYPH_IN_PLATE_FRAC = 0.76


def glyph_white_from_alpha(src: Image.Image) -> Image.Image:
    a = src.split()[3]
    white = Image.new("RGBA", src.size, (255, 255, 255, 255))
    white.putalpha(a)
    return white


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
    glyph = glyph_white_from_alpha(logo)

    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle((x1, y1, x2, y2), radius=radius, fill=PLATE_RGBA)

    gmax = max(1, int(plate_side * GLYPH_IN_PLATE_FRAC))
    gw, gh = glyph.size
    scale = min(gmax / gw, gmax / gh)
    nw, nh = max(1, int(gw * scale)), max(1, int(gh * scale))
    glyph = glyph.resize((nw, nh), Image.Resampling.LANCZOS)

    ox, oy = (SIZE - nw) // 2, (SIZE - nh) // 2
    canvas.alpha_composite(glyph, (ox, oy))

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(OUT_PATH, "PNG")
    print(f"Wrote {OUT_PATH} (plate {plate_side}px, inset {inset}px)")


if __name__ == "__main__":
    main()
