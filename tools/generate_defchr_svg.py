#!/usr/bin/env python3
import html
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BAS_PATH = ROOT / "high_drive.bas"
SVG_PATH = ROOT / "high_drive_defchr.svg"

DEFCHR_RE = re.compile(r'DEFCHR\$\((\d+)\)=HEXCHR\$\("([0-9A-Fa-f]+)"\)')

COLORS = {
    0: "none",
    1: "#0060ff",  # Blue
    2: "#e02020",  # Red
    3: "#d020ff",  # Blue + Red
    4: "#20c040",  # Green
    5: "#20d0d0",  # Blue + Green
    6: "#f0d020",  # Red + Green
    7: "#f8f8f8",  # Blue + Red + Green
}


def parse_defchrs(source: str) -> list[tuple[int, bytes]]:
    chars = []
    for code, hex_data in DEFCHR_RE.findall(source):
        data = bytes.fromhex(hex_data)
        if len(data) != 24:
            raise ValueError(f"DEFCHR$({code}) has {len(data)} bytes, expected 24")
        chars.append((int(code), data))
    return chars


def pixel_color(data: bytes, x: int, y: int) -> str:
    # Each 8-byte plane stores columns. Bit 7 is the top pixel, bit 0 is bottom.
    mask = 1 << (7 - y)
    blue = 1 if data[x] & mask else 0
    red = 2 if data[8 + x] & mask else 0
    green = 4 if data[16 + x] & mask else 0
    return COLORS[blue | red | green]


def symbol_for(code: int, data: bytes) -> str:
    parts = [f'  <symbol id="char-{code}" viewBox="0 0 8 8">']
    for y in range(8):
        for x in range(8):
            color = pixel_color(data, x, y)
            if color != "none":
                # Rotate 90 degrees clockwise after decoding the column-major data.
                rx = 7 - y
                ry = x
                parts.append(f'    <rect x="{rx}" y="{ry}" width="1" height="1" fill="{color}"/>')
    parts.append("  </symbol>")
    return "\n".join(parts)


def render_svg(chars: list[tuple[int, bytes]]) -> str:
    scale = 8
    gap = 4
    label_height = 5
    tile = 8 * scale
    width = gap + len(chars) * (tile + gap)
    height = gap + tile + label_height + gap

    symbols = "\n".join(symbol_for(code, data) for code, data in chars)
    uses = []
    for i, (code, _) in enumerate(chars):
        x = gap + i * (tile + gap)
        y = gap
        uses.append(
            f'  <use href="#char-{code}" x="{x}" y="{y}" width="{tile}" height="{tile}" '
            'style="image-rendering:pixelated"/>'
        )
        uses.append(
            f'  <text x="{x + tile / 2:.1f}" y="{y + tile + 4}" text-anchor="middle" '
            'font-family="monospace" font-size="3" fill="#222">'
            f'{html.escape(str(code))}</text>'
        )

    return "\n".join(
        [
            '<?xml version="1.0" encoding="UTF-8"?>',
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
            f'viewBox="0 0 {width} {height}">',
            "  <title>HIGH DRIVE DEFCHR bitmap characters</title>",
            "  <desc>8x8 bitmap characters decoded from high_drive.bas DEFCHR$ data. "
            "The byte planes are Blue, Red, then Green; each byte is one column.</desc>",
            "  <rect width=\"100%\" height=\"100%\" fill=\"#ffffff\"/>",
            "  <defs>",
            symbols,
            "  </defs>",
            *uses,
            "</svg>",
            "",
        ]
    )


def main() -> None:
    chars = parse_defchrs(BAS_PATH.read_text(encoding="utf-8"))
    SVG_PATH.write_text(render_svg(chars), encoding="utf-8")
    print(f"wrote {SVG_PATH.relative_to(ROOT)} ({len(chars)} characters)")


if __name__ == "__main__":
    main()
