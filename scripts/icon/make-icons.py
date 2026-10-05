"""Rasterize the vClip app icon (vlasiichuk.pro "Nebula face" V) for every platform.

Writes build/icon.png (1024px), build/icon.ico (16-256px), build/icon.icns
and resources/vclip-icon.png. Geometry mirrors resources/vclip-icon.svg
(from vlasiichuk.pro/v2.1/logo/icon-dark.svg); change both together.

Needs Pillow, which engine/.venv already has:
  engine/.venv/Scripts/python.exe scripts/icon/make-icons.py   (Windows)
  engine/.venv/bin/python scripts/icon/make-icons.py           (macOS/Linux)
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
SIZE = 1024
MASTER = 4096  # Supersampled, then downscaled for smooth edges.
RADIUS = 230.4  # Squircle corner radius on the 1024 grid (22.5%).
BG_TOP = (0x1A, 0x1F, 0x2C)
BG_BOTTOM = (0x10, 0x13, 0x1C)
RIM = (0xD6, 0xDB, 0xE6, round(0.16 * 255))
SHINE = (255, 255, 255, round(0.14 * 255))
LEFT_FACE = (0xF1, 0xF3, 0xF8, 255)   # silver light
RIGHT_FACE = (0xA9, 0xB8, 0xFF, 255)  # Nebula
# The V on a 100-unit grid, placed like the SVG: translate(156.44 157.58) scale(7.111).
LEFT = [(14, 16), (32, 16), (50, 58), (50, 88)]
RIGHT = [(50, 58), (68, 16), (86, 16), (50, 88)]
V_SCALE = 7.111111111111111
V_OFFSET = (156.44444444444446, 157.58222222222224)


def draw_master() -> Image.Image:
    k = MASTER / SIZE
    img = Image.new('RGBA', (MASTER, MASTER), (0, 0, 0, 0))

    # Vertical gradient background, clipped to the rounded square.
    gradient = Image.new('RGBA', (MASTER, MASTER))
    gd = ImageDraw.Draw(gradient)
    for y in range(MASTER):
        t = y / (MASTER - 1)
        gd.line([(0, y), (MASTER, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOTTOM)) + (255,))
    mask = Image.new('L', (MASTER, MASTER), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, MASTER - 1, MASTER - 1], radius=RADIUS * k, fill=255)
    img.paste(gradient, (0, 0), mask)

    overlay = Image.new('RGBA', (MASTER, MASTER), (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    d.rounded_rectangle([1 * k, 1 * k, (SIZE - 1) * k, (SIZE - 1) * k], radius=(RADIUS - 1) * k, outline=RIM, width=round(2 * k))
    d.line([(RADIUS * k, 2 * k), ((SIZE - RADIUS) * k, 2 * k)], fill=SHINE, width=round(3 * k))
    for points, color in ((LEFT, LEFT_FACE), (RIGHT, RIGHT_FACE)):
        d.polygon([((V_OFFSET[0] + x * V_SCALE) * k, (V_OFFSET[1] + y * V_SCALE) * k) for x, y in points], fill=color)
    img.alpha_composite(overlay)
    return img


def main() -> None:
    icon = draw_master().resize((SIZE, SIZE), Image.LANCZOS)
    (ROOT / 'build').mkdir(exist_ok=True)
    icon.save(ROOT / 'build/icon.png')
    icon.save(ROOT / 'resources/vclip-icon.png')
    icon.save(ROOT / 'build/icon.ico', sizes=[(n, n) for n in (16, 24, 32, 48, 64, 128, 256)])
    icon.save(ROOT / 'build/icon.icns')
    print('Wrote build/icon.png, build/icon.ico, build/icon.icns, resources/vclip-icon.png')


if __name__ == '__main__':
    main()
