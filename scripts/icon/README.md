# VlasiichukClip app icon

The icon is the vlasiichuk.pro mark: a `#1d1d1f` circle with a white line-art "V" and a small nested check. The brand rules live in `vlasiichuk.pro/BRAND.md` (never stretch, recolor, or add shadows or gradients).

## Source and exports

- **Vector masters:** `resources/vlasiichukclip-icon.svg` (light-background variant, used for the OS app icon) and `resources/vlasiichuk-mark.svg` (dark-background variant: `#fbfbfd` circle, `#1d1d1f` V, used inside the dark app UI).
- **Lockups:** `resources/vlasiichukclip-logo.svg` (dark surfaces) and `resources/vlasiichukclip-logo-light.svg` (light surfaces), used by the README. The in-app lockup is drawn inline in `src/renderer/components/brand/VlasiichukClipLogo.tsx` so it uses the app's Geist font.
- **App assets:** `build/icon.png` (1024px), `build/icon.ico` (Windows: 16–256px), `build/icon.icns` (macOS) and `resources/vlasiichukclip-icon.png`.

Regenerate the app assets on any OS with the engine's Python (it already has Pillow):

```bash
engine/.venv/Scripts/python.exe scripts/icon/make-icons.py
```

On macOS or Linux use `engine/.venv/bin/python`. The script mirrors the SVG geometry; change both together.
