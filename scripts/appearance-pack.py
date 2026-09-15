#!/usr/bin/env python3
"""Build and validate data-only NiuMa Merit appearance packs."""
import argparse
import json
import pathlib
import re
import struct
import sys
import zipfile

MAX_ARCHIVE = 50 * 1024 * 1024
MAX_MANIFEST = 64 * 1024
ARTWORK_TOP = 170
FEEDBACK_Y = 174
ROOT_KEYS = {"schema_version", "id", "version", "name_zh", "name_en", "author", "publisher",
             "review_id", "canvas_width", "canvas_height", "preview", "plus_y", "layers"}
LAYER_KEYS = {"image", "frame", "anchor", "keyframes"}
FRAME_KEYS = {"t", "x", "y", "rotation", "scale", "alpha"}


def fail(message):
    raise ValueError(message)


def safe_name(name):
    return bool(name) and not name.startswith(".") and "/" not in name and "\\" not in name \
        and ".." not in name and ":" not in name and (name == "manifest.json" or name.lower().endswith(".png"))


def number(value, low, high, label):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not low <= value <= high:
        fail(f"{label} must be between {low} and {high}")


def png_dimensions(data, label):
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        fail(f"{label} is not a PNG")
    width, height = struct.unpack(">II", data[16:24])
    if not (1 <= width <= 2048 and 1 <= height <= 2048):
        fail(f"{label} dimensions must be 1..2048")


def validate_payload(files):
    names = set(files)
    if len(names) != len(files) or len(names) < 2 or len(names) > 8 or "manifest.json" not in names:
        fail("pack must contain manifest.json and 1..7 unique files")
    if any(not safe_name(name) for name in names):
        fail("only root-level manifest.json and PNG files are allowed")
    raw = files["manifest.json"]
    if len(raw) > MAX_MANIFEST:
        fail("manifest.json exceeds 64KB")
    manifest = json.loads(raw.decode("utf-8"))
    if not isinstance(manifest, dict) or set(manifest) != ROOT_KEYS or manifest["schema_version"] != 1:
        fail("manifest schema or keys are invalid")
    if not isinstance(manifest["id"], str) or not re.fullmatch(r"[a-z0-9.-]{3,80}", manifest["id"]):
        fail("id must match [a-z0-9.-]{3,80}")
    for key, limit in (("version", 32), ("name_zh", 80), ("name_en", 80), ("author", 80),
                       ("publisher", 80), ("review_id", 80)):
        if not isinstance(manifest[key], str) or not manifest[key] or len(manifest[key]) > limit:
            fail(f"{key} is invalid")
    if manifest["canvas_width"] != 240 or manifest["canvas_height"] != 250:
        fail("canvas must be 240x250")
    number(manifest["plus_y"], FEEDBACK_Y, FEEDBACK_Y, "plus_y")
    preview = manifest["preview"]
    layers = manifest["layers"]
    if not isinstance(preview, str) or not safe_name(preview) or not isinstance(layers, list) or not 1 <= len(layers) <= 6:
        fail("preview or layers are invalid")
    expected = {"manifest.json", preview}
    for index, layer in enumerate(layers):
        if not isinstance(layer, dict) or set(layer) != LAYER_KEYS:
            fail(f"layer {index} keys are invalid")
        image = layer["image"]
        rect, anchor, frames = layer["frame"], layer["anchor"], layer["keyframes"]
        if not isinstance(image, str) or not safe_name(image):
            fail(f"layer {index} image is invalid")
        if not isinstance(rect, list) or len(rect) != 4 or not isinstance(anchor, list) or len(anchor) != 2:
            fail(f"layer {index} geometry is invalid")
        for value, low, high, label in zip(rect, (-240, -250, 1, 1), (480, 500, 480, 500), ("x", "y", "w", "h")):
            number(value, low, high, f"layer {index} {label}")
        if rect[1] + rect[3] > ARTWORK_TOP:
            fail(f"layer {index} enters the reserved +1 or counter region")
        number(anchor[0], 0, 1, f"layer {index} anchor x")
        number(anchor[1], 0, 1, f"layer {index} anchor y")
        if not isinstance(frames, list) or not 1 <= len(frames) <= 8:
            fail(f"layer {index} keyframe count is invalid")
        previous = -1
        for frame in frames:
            if not isinstance(frame, dict) or set(frame) != FRAME_KEYS:
                fail(f"layer {index} keyframe keys are invalid")
            number(frame["t"], 0, 1, "t")
            if frame["t"] < previous:
                fail("keyframes must be sorted by t")
            previous = frame["t"]
            for key, low, high in (("x", -480, 480), ("y", -500, 500), ("rotation", -180, 180),
                                   ("scale", .1, 4), ("alpha", 0, 1)):
                number(frame[key], low, high, key)
        expected.add(image)
    if names != expected:
        fail("archive files must exactly match manifest declarations")
    for name in expected - {"manifest.json"}:
        png_dimensions(files[name], name)
    return manifest


def read_directory(path):
    files = {}
    for item in path.iterdir():
        if not item.is_file() or item.is_symlink():
            fail("source may contain regular root-level files only")
        files[item.name] = item.read_bytes()
    return files


def read_archive(path):
    if path.stat().st_size > MAX_ARCHIVE:
        fail("archive exceeds 50MB")
    with zipfile.ZipFile(path) as archive:
        files = {}
        for info in archive.infolist():
            if info.is_dir() or info.filename in files:
                fail("directories and duplicate entries are not allowed")
            files[info.filename] = archive.read(info)
        return files


def command_validate(path):
    files = read_archive(path) if path.is_file() else read_directory(path)
    manifest = validate_payload(files)
    print(f"VALID id={manifest['id']} version={manifest['version']} files={len(files)}")


def command_build(source, output):
    files = read_directory(source)
    manifest = validate_payload(files)
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name in sorted(files):
            info = zipfile.ZipInfo(name, (2020, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, files[name])
    command_validate(output)
    print(f"BUILT path={output} bytes={output.stat().st_size} id={manifest['id']}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    validate = sub.add_parser("validate")
    validate.add_argument("path", type=pathlib.Path)
    build = sub.add_parser("build")
    build.add_argument("source", type=pathlib.Path)
    build.add_argument("output", type=pathlib.Path)
    args = parser.parse_args()
    try:
        if args.command == "validate":
            command_validate(args.path)
        else:
            command_build(args.source, args.output)
    except (OSError, ValueError, zipfile.BadZipFile, json.JSONDecodeError) as error:
        print(f"INVALID: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
