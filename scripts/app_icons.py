#!/usr/bin/env python3
"""PWA icons from the native launcher icon (needs Pillow: pip install pillow).

Android adaptive icon (foreground PNG drawn on the 108dp canvas, plus a background color or PNG):
    python app_icons.py --foreground app/src/main/res/drawable-nodpi/ic_launcher_foreground.png \
        --background "#15111E" --monochrome app/src/main/res/drawable-nodpi/ic_launcher_monochrome.png --out PWA/web/public

iOS (AppIcon 1024 PNG, already full bleed):
    python app_icons.py --foreground ios/App/Assets.xcassets/AppIcon.appiconset/icon-1024.png --out PWA/web/public

Vector-only launcher icons (adaptive XML with a vector drawable): render the vector to a 1024 PNG first
(Android Studio > Image Asset, or the SVG through any rasterizer) and pass it as --foreground.

Writes icon-192/512 (rounded, purpose "any"), icon-maskable-192/512 (full bleed, the launcher crops it),
apple-touch-icon.png (180, full bleed: iOS rounds it) and badge.png (96, white silhouette for Android's
status bar, from --monochrome or from the foreground alpha).
"""
import argparse
from pathlib import Path

from PIL import Image, ImageDraw


def layer(path_or_color: str | None, size: int) -> Image.Image:
    if not path_or_color:
        return Image.new('RGBA', (size, size), (0, 0, 0, 0))
    if path_or_color.startswith('#'):
        value = path_or_color.lstrip('#')
        rgb = tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))
        return Image.new('RGBA', (size, size), (*rgb, 255))
    return Image.open(path_or_color).convert('RGBA').resize((size, size), Image.LANCZOS)


def full_bleed(foreground: str, background: str | None, size: int) -> Image.Image:
    canvas = layer(background, size)
    canvas.alpha_composite(layer(foreground, size))
    return canvas


def rounded(image: Image.Image, radius_ratio: float = 0.225) -> Image.Image:
    size = image.size[0]
    mask = Image.new('L', image.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=int(size * radius_ratio), fill=255)
    out = Image.new('RGBA', image.size, (0, 0, 0, 0))
    out.paste(image, (0, 0), mask)
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--foreground', required=True)
    parser.add_argument('--background', help='"#RRGGBB" or a PNG (adaptive icon background)')
    parser.add_argument('--monochrome', help='PNG silhouette for the notification badge')
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    for size in (192, 512):
        icon = full_bleed(args.foreground, args.background, size)
        icon.save(out / f'icon-maskable-{size}.png')
        rounded(icon).save(out / f'icon-{size}.png')
    full_bleed(args.foreground, args.background, 180).convert('RGB').save(out / 'apple-touch-icon.png')

    source = layer(args.monochrome or args.foreground, 96)
    alpha = source.getchannel('A')
    badge = Image.new('RGBA', (96, 96), (255, 255, 255, 0))
    badge.putalpha(alpha)
    badge.save(out / 'badge.png')
    print('Icons written to', out)


if __name__ == '__main__':
    main()
