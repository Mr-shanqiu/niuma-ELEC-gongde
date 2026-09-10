#!/usr/bin/env python3
"""Generate a Windows-compatible ICO from woodfish.png.

Pillow's ICO writer uses PNG-embedded entries by default, which MSVC's RC
compiler rejects with RC2169. Even with bitmap_format='bmp', Pillow doesn't
set biHeight to 2*height (required for ICO's XOR+AND mask convention).

This script manually constructs a valid ICO with:
  - 24-bit BMP entries (no alpha, white background)
  - biHeight = 2 * actual_height (XOR mask height + AND mask height)
  - All-zero AND mask (fully visible)
"""
import struct
import io
import os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "assets", "woodfish.png")
OUT = os.path.join(ROOT, "assets", "appicon.ico")

def main():
    src = Image.open(SRC).convert("RGBA")
    w, h = src.size
    side = max(w, h)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(src, ((side - w) // 2, (side - h) // 2))

    bg = Image.new("RGB", (side, side), (255, 255, 255))
    bg.paste(canvas, mask=canvas.split()[3])

    ico_sizes = [16, 32, 48, 64, 128]
    entries = []
    for size in ico_sizes:
        resized = bg.resize((size, size), Image.LANCZOS).convert("RGB")
        buf = io.BytesIO()
        resized.save(buf, format="BMP", bits=24)
        bmp = buf.getvalue()
        bih = bytearray(bmp[14:54])
        pixel_data = bmp[54:]
        struct.pack_into("<i", bih, 8, size * 2)
        row_bytes = ((size + 31) // 32) * 4
        and_mask = b"\x00" * (row_bytes * size)
        entry = bytes(bih) + pixel_data + and_mask
        entries.append((size, entry))

    header = struct.pack("<HHH", 0, 1, len(ico_sizes))
    offset = 6 + 16 * len(ico_sizes)
    directory = b""
    for size, data in entries:
        w_byte = size if size < 256 else 0
        directory += struct.pack("<BBBBHHII",
            w_byte, w_byte, 0, 0, 1, 24, len(data), offset)
        offset += len(data)

    with open(OUT, "wb") as f:
        f.write(header)
        f.write(directory)
        for _, data in entries:
            f.write(data)
    print(f"ICO: {os.path.getsize(OUT)} bytes ({len(ico_sizes)} entries)")

if __name__ == "__main__":
    main()
