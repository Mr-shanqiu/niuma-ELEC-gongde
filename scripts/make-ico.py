#!/usr/bin/env python3
"""Generate a Windows-compatible ICO from woodfish.png.

Pillow's ICO writer uses PNG-embedded entries by default, which MSVC's RC
compiler rejects with RC2169. Even with bitmap_format='bmp', Pillow doesn't
set biHeight to 2*height (required for ICO's XOR+AND mask convention).

This script manually constructs a valid ICO with:
  - 32-bit BGRA DIB entries with transparency
  - biHeight = 2 * actual_height (XOR mask height + AND mask height)
  - A 1-bit AND mask derived from transparent pixels
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

    ico_sizes = [16, 32, 48, 64, 128]
    entries = []
    for size in ico_sizes:
        resized = canvas.resize((size, size), Image.LANCZOS).convert("RGBA")

        # ICO DIB rows are stored bottom-up. Each XOR pixel is BGRA.
        xor_rows = []
        for y in range(size - 1, -1, -1):
            row = bytearray()
            for r, g, b, a in (resized.getpixel((x, y)) for x in range(size)):
                row.extend((b, g, r, a))
            xor_rows.append(bytes(row))
        xor_bitmap = b"".join(xor_rows)

        # The AND mask uses one bit per pixel and four-byte-aligned rows.
        # A set bit marks a fully transparent pixel for legacy icon readers.
        mask_row_bytes = ((size + 31) // 32) * 4
        mask_rows = []
        for y in range(size - 1, -1, -1):
            row = bytearray(mask_row_bytes)
            for x in range(size):
                if resized.getpixel((x, y))[3] == 0:
                    row[x // 8] |= 0x80 >> (x % 8)
            mask_rows.append(bytes(row))
        and_mask = b"".join(mask_rows)

        image_bytes = len(xor_bitmap) + len(and_mask)
        bih = struct.pack(
            "<IiiHHIIiiII",
            40, size, size * 2, 1, 32, 0, image_bytes, 0, 0, 0, 0)
        entry = bih + xor_bitmap + and_mask
        entries.append((size, entry))

    header = struct.pack("<HHH", 0, 1, len(ico_sizes))
    offset = 6 + 16 * len(ico_sizes)
    directory = b""
    for size, data in entries:
        w_byte = size if size < 256 else 0
        directory += struct.pack("<BBBBHHII",
            w_byte, w_byte, 0, 0, 1, 32, len(data), offset)
        offset += len(data)

    with open(OUT, "wb") as f:
        f.write(header)
        f.write(directory)
        for _, data in entries:
            f.write(data)
    print(f"ICO: {os.path.getsize(OUT)} bytes ({len(ico_sizes)} entries)")

if __name__ == "__main__":
    main()
