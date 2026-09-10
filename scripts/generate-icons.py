#!/usr/bin/env python3
"""Generate app icons (macOS .icns + Windows .ico) from woodfish.png.

The source image is 600x500 with transparency. We pad it to a square
canvas, then generate all required resolutions for both platforms.
"""
import struct
import io
import os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "assets", "woodfish.png")
ASSETS_DIR = os.path.join(ROOT, "assets")

# All icon sizes we need
SIZES = [16, 32, 64, 128, 256, 512, 1024]

def make_square(src_path):
    """Load image, pad to square with transparency, return RGBA Image."""
    img = Image.open(src_path).convert("RGBA")
    w, h = img.size
    side = max(w, h)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(img, ((side - w) // 2, (side - h) // 2))
    return canvas

def make_icns(square_img, output_path):
    """Create a .icns file from a square RGBA image."""
    # macOS iconset requires these sizes:
    # 16, 32(@2x=64), 32, 64(@2x=128), 128, 256(@2x=512), 256, 512(@2x=1024), 512
    iconset_entries = [
        (16, "ic07"),    # 16x16
        (32, "ic08"),    # 32x32
        (64, "ic09"),    # 64x64 (16x16@2x)
        (128, "ic10"),   # 128x128
        (256, "ic11"),   # 256x256
        (512, "ic12"),   # 512x512
        (1024, "ic13"),  # 1024x1024 (512x512@2x)
    ]

    chunks = []
    # Magic header
    chunks.append(b"icns")

    body = b""
    for size, ostype in iconset_entries:
        resized = square_img.resize((size, size), Image.LANCZOS)
        png_data = io.BytesIO()
        resized.save(png_data, format="PNG")
        png_bytes = png_data.getvalue()
        # Each chunk: 4-byte OSType + 4-byte length (big-endian) + data
        body += ostype.encode("ascii")
        body += struct.pack(">I", len(png_bytes) + 8)
        body += png_bytes

    total_len = len(body) + 8  # 8 for "icns" + length itself
    chunks.append(struct.pack(">I", total_len))
    chunks.append(body)

    with open(output_path, "wb") as f:
        f.write(b"".join(chunks))
    print(f"icns: {output_path} ({total_len} bytes)")

def make_ico(square_img, output_path):
    """Create a multi-resolution .ico file (PNG-embedded entries)."""
    ico_sizes = [16, 32, 48, 64, 128, 256]
    png_entries = []
    for size in ico_sizes:
        resized = square_img.resize((size, size), Image.LANCZOS)
        buf = io.BytesIO()
        resized.save(buf, format="PNG")
        png_entries.append(buf.getvalue())

    # ICONDIR header: reserved(2) + type(2) + count(2)
    header = struct.pack("<HHH", 0, 1, len(ico_sizes))
    # Each ICONDIRENTRY is 16 bytes
    offset = 6 + 16 * len(ico_sizes)
    dir_entries = b""
    for i, size in enumerate(ico_sizes):
        data = png_entries[i]
        w_byte = 0 if size >= 256 else size
        h_byte = 0 if size >= 256 else size
        entry = struct.pack("<BBBBHHII",
            w_byte, h_byte, 0, 0,   # width, height, palette, reserved
            1, 32,                   # type=1 (icon), bpp
            len(data), offset)
        dir_entries += entry
        offset += len(data)

    with open(output_path, "wb") as f:
        f.write(header)
        f.write(dir_entries)
        for data in png_entries:
            f.write(data)
    fsize = os.path.getsize(output_path)
    print(f"ico: {output_path} ({fsize} bytes)")

def main():
    print(f"Source: {SRC}")
    img = make_square(SRC)
    print(f"Square canvas: {img.size[0]}x{img.size[1]}")

    icns_path = os.path.join(ASSETS_DIR, "appicon.icns")
    ico_path = os.path.join(ASSETS_DIR, "appicon.ico")
    # Also save a 512x512 PNG for reference
    png_path = os.path.join(ASSETS_DIR, "appicon.png")
    img.resize((512, 512), Image.LANCZOS).save(png_path)
    print(f"png: {png_path} ({os.path.getsize(png_path)} bytes)")

    make_icns(img, icns_path)
    make_ico(img, ico_path)

if __name__ == "__main__":
    main()
