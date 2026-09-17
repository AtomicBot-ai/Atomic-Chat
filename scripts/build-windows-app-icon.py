#!/usr/bin/env python3
#* icon.ico for Windows: full-bleed logo-app.png without the macOS padding, so the icon
#* fills its taskbar tile like neighboring apps do. tauri icon builds
#* icon.ico from icon.png with ~18% padding (for the Dock), which made the icon look smaller.
#* macOS (icon.icns) and Linux (icon.png) are left untouched — this is a Windows-only asset.
from __future__ import annotations

import io
import struct
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "web-app" / "public" / "images" / "logo-app.png"
OUT = ROOT / "src-tauri" / "icons" / "icon.ico"
SIZES = (16, 24, 32, 48, 64, 128, 256)


def main() -> None:
    if not SRC.is_file():
        print(f"Missing {SRC}", file=sys.stderr)
        sys.exit(1)

    im = Image.open(SRC).convert("RGBA")

    blobs: list[tuple[int, bytes]] = []
    for n in SIZES:
        frame = im.resize((n, n), Image.Resampling.LANCZOS)
        buf = io.BytesIO()
        frame.save(buf, format="PNG")
        blobs.append((n, buf.getvalue()))

    count = len(blobs)
    header = struct.pack("<HHH", 0, 1, count)
    offset = 6 + count * 16
    entries = b""
    body = b""
    for n, data in blobs:
        #? for 256, width/height are encoded as zero in ICONDIRENTRY
        dim = 0 if n >= 256 else n
        entries += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset)
        body += data
        offset += len(data)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(header + entries + body)
    print(f"Wrote {OUT} ({count} sizes: {', '.join(map(str, SIZES))})")


if __name__ == "__main__":
    main()
