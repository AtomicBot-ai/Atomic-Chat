#!/usr/bin/env python3
#* 1024×1024 for `tauri icon`: logo-app.png with padding so it matches system icons in the Dock.
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
LOGO_APP_PATH = ROOT / "web-app" / "public" / "images" / "logo-app.png"
OUT_PATH = ROOT / "src-tauri" / "icons" / "icon.png"
SIZE = 1024
#? Fraction of the frame used by the art (the rest is a transparent inset, like typical macOS icons in the Dock grid)
DOCK_ART_FRAC = 0.82


def main() -> None:
    if not LOGO_APP_PATH.is_file():
        print(f"Missing {LOGO_APP_PATH}", file=sys.stderr)
        sys.exit(1)

    im = Image.open(LOGO_APP_PATH)
    #? P / RGB — convert to RGBA for a uniform PNG
    im = im.convert("RGBA")

    side = max(1, int(round(SIZE * DOCK_ART_FRAC)))
    im = im.resize((side, side), Image.Resampling.LANCZOS)

    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    ox = (SIZE - side) // 2
    oy = (SIZE - side) // 2
    canvas.alpha_composite(im, (ox, oy))

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(OUT_PATH, "PNG")
    print(
        f"Wrote {OUT_PATH} from {LOGO_APP_PATH} ({SIZE}×{SIZE}, art {side}px, frac={DOCK_ART_FRAC})"
    )


if __name__ == "__main__":
    main()
