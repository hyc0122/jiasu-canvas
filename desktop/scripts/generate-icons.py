#!/usr/bin/env python3
"""Rasterize the project logo into PNG/ICO for Electron (no external assets)."""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "build"
ELECTRON = ROOT / "electron"

BG = (28, 25, 23, 255)
FG = (245, 240, 232, 255)

# Paths from web/public/logo.svg (viewBox 64x64).
MOUNTAIN = [(32, 8), (58, 54), (46, 54), (32, 29), (18, 54), (6, 54)]
NOTCH = [(32, 40), (40, 54), (24, 54)]


def transform(points, size, pad):
    scale = (size - 2 * pad) / 64
    return [(pad + x * scale, pad + y * scale) for x, y in points]


def draw_logo(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    radius = max(1, int(size * 0.22))
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=BG)
    pad = size * 0.16
    draw.polygon(transform(MOUNTAIN, size, pad), fill=FG)
    draw.polygon(transform(NOTCH, size, pad), fill=FG)
    return img


def main() -> None:
    BUILD.mkdir(parents=True, exist_ok=True)
    ELECTRON.mkdir(parents=True, exist_ok=True)
    master = draw_logo(1024)
    master.save(BUILD / "icon.png", format="PNG")
    icons_dir = BUILD / "icons"
    icons_dir.mkdir(parents=True, exist_ok=True)
    for size in (16, 32, 48, 64, 128, 256, 512, 1024):
        master.resize((size, size), Image.Resampling.LANCZOS).save(icons_dir / f"{size}x{size}.png", format="PNG")
    master.resize((512, 512), Image.Resampling.LANCZOS).save(ELECTRON / "icon.png", format="PNG")
    ico_source = master.resize((256, 256), Image.Resampling.LANCZOS)
    ico_source.save(
        BUILD / "icon.ico",
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print(f"wrote {BUILD / 'icon.png'}")
    print(f"wrote {BUILD / 'icon.ico'}")
    print(f"wrote {ELECTRON / 'icon.png'}")


if __name__ == "__main__":
    main()
