#!/usr/bin/env python3
#* 1024×1024 PNG для tauri icon: логотип по центру, прозрачные углы (скруглённая маска).
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
LOGO_PATH = ROOT / "web-app" / "public" / "images" / "atomic-chat-logo.png"
OUT_PATH = ROOT / "src-tauri" / "icons" / "icon.png"
SIZE = 1024
#? Внутреннее поле под глиф (~как у Apple template)
PADDING_FRAC = 0.11
#? Радиус скругления маски холста (доля стороны) — ближе к squircle в Dock
RADIUS_FRAC = 0.223


def main() -> None:
    if not LOGO_PATH.is_file():
        print(f"Missing {LOGO_PATH}", file=sys.stderr)
        sys.exit(1)

    logo = Image.open(LOGO_PATH).convert("RGBA")
    inner = max(1, int(SIZE * (1 - 2 * PADDING_FRAC)))
    lw, lh = logo.size
    scale = min(inner / lw, inner / lh)
    nw, nh = max(1, int(lw * scale)), max(1, int(lh * scale))
    logo = logo.resize((nw, nh), Image.Resampling.LANCZOS)

    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    ox, oy = (SIZE - nw) // 2, (SIZE - nh) // 2
    canvas.paste(logo, (ox, oy), logo)

    radius = max(1, int(SIZE * RADIUS_FRAC))
    mask = Image.new("L", (SIZE, SIZE), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, SIZE - 1, SIZE - 1), radius=radius, fill=255)

    alpha = canvas.split()[3]
    alpha = ImageChops.multiply(alpha, mask)
    canvas.putalpha(alpha)

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(OUT_PATH, "PNG")
    print(f"Wrote {OUT_PATH}")


if __name__ == "__main__":
    main()
