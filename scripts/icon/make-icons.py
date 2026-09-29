"""Rasterize the VlasiichukClip app icon (vlasiichuk.pro mark) for every platform.

Writes build/icon.png (1024px), build/icon.ico (16-256px), build/icon.icns
and resources/vlasiichukclip-icon.png. Geometry mirrors
resources/vlasiichukclip-icon.svg; change both together.

Needs Pillow, which engine/.venv already has:
  engine/.venv/Scripts/python.exe scripts/icon/make-icons.py   (Windows)
  engine/.venv/bin/python scripts/icon/make-icons.py           (macOS/Linux)
"""
import math
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
CIRCLE = (0x1D, 0x1D, 0x1F, 255)
MARK = (0xFF, 0xFF, 0xFF, 255)
# SVG viewBox is 100 units; stroke 6 with round caps and joins.
STROKES = [[(30, 30), (50, 70), (70, 30)], [(43, 51), (50, 64), (57, 51)]]
STROKE_WIDTH = 6
MASTER = 4096  # Supersampled, then downscaled for smooth edges.


def draw_master() -> Image.Image:
    s = MASTER / 100
    img = Image.new('RGBA', (MASTER, MASTER), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse([(50 - 46) * s, (50 - 46) * s, (50 + 46) * s, (50 + 46) * s], fill=CIRCLE)
    r = STROKE_WIDTH / 2 * s
    for line in STROKES:
        pts = [(x * s, y * s) for x, y in line]
        for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
            length = math.hypot(x2 - x1, y2 - y1)
            nx, ny = -(y2 - y1) / length * r, (x2 - x1) / length * r
            d.polygon([(x1 + nx, y1 + ny), (x2 + nx, y2 + ny), (x2 - nx, y2 - ny), (x1 - nx, y1 - ny)], fill=MARK)
        for x, y in pts:  # Round caps and joins.
            d.ellipse([x - r, y - r, x + r, y + r], fill=MARK)
    return img


def main() -> None:
    master = draw_master()
    icon = master.resize((1024, 1024), Image.LANCZOS)
    (ROOT / 'build').mkdir(exist_ok=True)
    icon.save(ROOT / 'build/icon.png')
    icon.save(ROOT / 'resources/vlasiichukclip-icon.png')
    icon.save(ROOT / 'build/icon.ico', sizes=[(n, n) for n in (16, 24, 32, 48, 64, 128, 256)])
    icon.save(ROOT / 'build/icon.icns')
    print('Wrote build/icon.png, build/icon.ico, build/icon.icns, resources/vlasiichukclip-icon.png')


if __name__ == '__main__':
    main()
