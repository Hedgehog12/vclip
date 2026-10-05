# vClip app icon

The icon is the vlasiichuk.pro "Nebula face" V: the left face in silver light (`#F1F3F8`), the right face in Nebula (`#A9B8FF`), on a dark rounded square (`#1A1F2C` to `#10131C`). One mark serves every vlasiichuk.pro tool. The brand rules live in `vlasiichuk.pro/BRAND.md` and `vlasiichuk.pro/v2/BRAND.md` (never recolor, rotate, outline or add shadows or glows).

## Source and exports

- **Vector masters:** `resources/vclip-icon.svg` (the OS app icon and the in-app icon tile) and `resources/vlasiichuk-mark.svg` (the V alone, used in the sidebar). Both are copied from `vlasiichuk.pro/v2.1/logo/` (`icon-dark.svg`, `vmark-dark.svg`).
- **Lockups:** `resources/vclip-logo.svg` (dark surfaces) and `resources/vclip-logo-light.svg` (light surfaces), used by the README. They are `lockup-tool-dark.svg` and `lockup-tool-paper.svg` from the same folder, with the text drawn as outlines. The in-app lockup is `src/renderer/components/brand/VClipLogo.tsx`, which sets the text live in Inter.
- **App assets:** `build/icon.png` (1024px), `build/icon.ico` (Windows: 16–256px), `build/icon.icns` (macOS) and `resources/vclip-icon.png`.

Regenerate the app assets on any OS with the engine's Python (it already has Pillow):

```bash
engine/.venv/Scripts/python.exe scripts/icon/make-icons.py
```

On macOS or Linux use `engine/.venv/bin/python`. The script mirrors the SVG geometry; change both together.
