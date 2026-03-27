#!/usr/bin/env python3
#* 1024×1024 для `tauri icon`: logo-app.png с полями, чтобы в Dock совпадала с системными иконками.
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
LOGO_APP_PATH = ROOT / "web-app" / "public" / "images" / "logo-app.png"
OUT_PATH = ROOT / "src-tauri" / "icons" / "icon.png"
SIZE = 1024
#? Доля кадра под арт (остальное — прозрачный inset, как у типичных macOS-иконок в сетке Dock)
DOCK_ART_FRAC = 0.82


def main() -> None:
    if not LOGO_APP_PATH.is_file():
        print(f"Missing {LOGO_APP_PATH}", file=sys.stderr)
        sys.exit(1)

    im = Image.open(LOGO_APP_PATH)
    #? P / RGB — приводим к RGBA для единообразного PNG
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
