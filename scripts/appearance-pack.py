#!/usr/bin/env python3
"""Build, sign, and validate data-only NiuMa Merit appearance packs."""
import argparse
import hashlib
import json
import pathlib
import re
import secrets
import struct
import subprocess
import sys
import tempfile
import time
import zipfile

MAX_ARCHIVE = 50 * 1024 * 1024
MAX_MANIFEST = 64 * 1024
ARTWORK_TOP = 170
FEEDBACK_Y = 174
ROOT_KEYS_V1 = {"schema_version", "id", "version", "name_zh", "name_en", "author",
                "publisher", "review_id", "canvas_width", "canvas_height",
                "preview", "plus_y", "layers"}
ROOT_KEYS_V2 = ROOT_KEYS_V1 | {"license"}
LICENSE_KEYS = {"mode", "issued_at", "import_before", "download_id",
                "content_sha256", "signature"}
LAYER_KEYS = {"image", "frame", "anchor", "keyframes"}
FRAME_KEYS = {"t", "x", "y", "rotation", "scale", "alpha"}
PUBLIC_KEY_PEM = b"""-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEKsX8RSYB05zE4p7P+bYWleMceGcn
QRoBJtPXtTUqbb1JuKb3bHrig2DxgK8huBeiLJ4FHfYX2dzBs7iZh2Iitw==
-----END PUBLIC KEY-----
"""


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


def content_hash(files):
    digest = hashlib.sha256()
    for name in sorted(name for name in files if name != "manifest.json"):
        data = files[name]
        digest.update(name.encode("utf-8"))
        digest.update(b"\0")
        digest.update(len(data).to_bytes(8, "big"))
        digest.update(data)
    return digest.hexdigest()


def license_message(manifest):
    license_data = manifest["license"]
    return (
        "NIUMA-PACK-LICENSE-V1\n"
        f"{manifest['id']}\n{manifest['version']}\n"
        f"{license_data['issued_at']}\n{license_data['import_before']}\n"
        f"{license_data['download_id']}\n{license_data['content_sha256']}"
    ).encode("utf-8")


def der_to_raw(der):
    position = 0
    if len(der) < 8 or der[position] != 0x30:
        fail("OpenSSL returned an invalid ECDSA signature")
    position += 1
    sequence_length = der[position]
    position += 1
    if sequence_length & 0x80:
        count = sequence_length & 0x7f
        sequence_length = int.from_bytes(der[position:position + count], "big")
        position += count
    values = []
    for _ in range(2):
        if position + 2 > len(der) or der[position] != 0x02:
            fail("OpenSSL returned an invalid ECDSA integer")
        position += 1
        length = der[position]
        position += 1
        integer = der[position:position + length]
        position += length
        integer = integer.lstrip(b"\0")
        if len(integer) > 32:
            fail("ECDSA integer exceeds P-256")
        values.append(integer.rjust(32, b"\0"))
    if position != len(der):
        fail("ECDSA signature has trailing data")
    return b"".join(values)


def raw_to_der(raw):
    if len(raw) != 64:
        fail("signature must contain 64 raw P-256 bytes")
    body = bytearray()
    for offset in (0, 32):
        integer = raw[offset:offset + 32].lstrip(b"\0") or b"\0"
        if integer[0] & 0x80:
            integer = b"\0" + integer
        body.extend((0x02, len(integer)))
        body.extend(integer)
    return bytes((0x30, len(body))) + bytes(body)


def verify_signature(manifest):
    try:
        raw = bytes.fromhex(manifest["license"]["signature"])
    except ValueError as error:
        fail(f"signature is not lowercase hex: {error}")
    with tempfile.TemporaryDirectory() as directory:
        root = pathlib.Path(directory)
        public_key = root / "public.pem"
        message = root / "message.bin"
        signature = root / "signature.der"
        public_key.write_bytes(PUBLIC_KEY_PEM)
        message.write_bytes(license_message(manifest))
        signature.write_bytes(raw_to_der(raw))
        result = subprocess.run(
            ["openssl", "dgst", "-sha256", "-verify", str(public_key),
             "-signature", str(signature), str(message)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        if result.returncode != 0:
            fail("license signature is invalid")


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
    if not isinstance(manifest, dict):
        fail("manifest must be an object")
    schema = manifest.get("schema_version")
    expected_root = ROOT_KEYS_V1 if schema == 1 else ROOT_KEYS_V2 if schema == 2 else None
    if expected_root is None or set(manifest) != expected_root:
        fail("manifest schema or keys are invalid")
    if not isinstance(manifest["id"], str) or not re.fullmatch(r"[a-z0-9.-]{3,80}", manifest["id"]):
        fail("id must match [a-z0-9.-]{3,80}")
    for key, limit in (("version", 32), ("name_zh", 80), ("name_en", 80),
                       ("author", 80), ("publisher", 80), ("review_id", 80)):
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
            if frame["t"] <= previous:
                fail("keyframes must be strictly sorted by t")
            previous = frame["t"]
            for key, low, high in (("x", -480, 480), ("y", -500, 500),
                                   ("rotation", -180, 180), ("scale", .1, 4),
                                   ("alpha", 0, 1)):
                number(frame[key], low, high, key)
        if frames[0]["t"] != 0:
            fail("each layer must begin at t=0")
        expected.add(image)
    if names != expected:
        fail("archive files must exactly match manifest declarations")
    for name in expected - {"manifest.json"}:
        png_dimensions(files[name], name)
    if schema == 2:
        license_data = manifest["license"]
        if not isinstance(license_data, dict) or set(license_data) != LICENSE_KEYS:
            fail("license fields are invalid")
        if license_data.get("mode") != "timed":
            fail("schema 2 requires timed import mode")
        issued = license_data.get("issued_at")
        deadline = license_data.get("import_before")
        if not isinstance(issued, int) or not isinstance(deadline, int) or \
                not 1577836800 <= issued <= 4102444800 or \
                not issued < deadline <= issued + 86400:
            fail("timed import window must be no more than 24 hours")
        if not isinstance(license_data.get("download_id"), str) or \
                not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", license_data["download_id"]):
            fail("download_id is invalid")
        if not isinstance(license_data.get("content_sha256"), str) or \
                not re.fullmatch(r"[0-9a-f]{64}", license_data["content_sha256"]):
            fail("content_sha256 is invalid")
        if license_data["content_sha256"] != content_hash(files):
            fail("content_sha256 does not match PNG content")
        if not isinstance(license_data.get("signature"), str) or \
                not re.fullmatch(r"[0-9a-f]{128}", license_data["signature"]):
            fail("signature is invalid")
        verify_signature(manifest)
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


def write_archive(files, output):
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name in sorted(files):
            info = zipfile.ZipInfo(name, (2020, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, files[name])


def command_validate(path):
    files = read_archive(path) if path.is_file() else read_directory(path)
    manifest = validate_payload(files)
    mode = "timed" if manifest["schema_version"] == 2 else "free"
    print(f"VALID id={manifest['id']} version={manifest['version']} mode={mode} files={len(files)}")


def command_build(source, output):
    files = read_directory(source)
    manifest = validate_payload(files)
    if manifest["schema_version"] != 1:
        fail("build creates permanent free packs; use sign for timed packs")
    write_archive(files, output)
    command_validate(output)
    print(f"BUILT path={output} bytes={output.stat().st_size} id={manifest['id']}")


def command_sign(source, output, private_key, valid_hours, download_id, issued_at):
    files = read_directory(source)
    manifest = validate_payload(files)
    if manifest["schema_version"] != 1:
        fail("sign source must be a schema 1 free-pack directory")
    if not 0 < valid_hours <= 24:
        fail("valid-hours must be in the range 1..24")
    issued = int(time.time()) if issued_at is None else issued_at
    manifest["schema_version"] = 2
    manifest["license"] = {
        "mode": "timed",
        "issued_at": issued,
        "import_before": issued + valid_hours * 3600,
        "download_id": download_id or secrets.token_hex(16),
        "content_sha256": content_hash(files),
        "signature": "0" * 128,
    }
    message = license_message(manifest)
    result = subprocess.run(
        ["openssl", "dgst", "-sha256", "-sign", str(private_key)],
        input=message, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if result.returncode != 0:
        fail("OpenSSL could not sign the pack")
    manifest["license"]["signature"] = der_to_raw(result.stdout).hex()
    files["manifest.json"] = (
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
    ).encode("utf-8")
    validate_payload(files)
    write_archive(files, output)
    command_validate(output)
    print(f"SIGNED path={output} import_before={manifest['license']['import_before']} id={manifest['id']}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    validate = sub.add_parser("validate")
    validate.add_argument("path", type=pathlib.Path)
    build = sub.add_parser("build")
    build.add_argument("source", type=pathlib.Path)
    build.add_argument("output", type=pathlib.Path)
    sign = sub.add_parser("sign")
    sign.add_argument("source", type=pathlib.Path)
    sign.add_argument("output", type=pathlib.Path)
    sign.add_argument("--private-key", type=pathlib.Path, required=True)
    sign.add_argument("--valid-hours", type=int, default=24)
    sign.add_argument("--download-id")
    sign.add_argument("--issued-at", type=int)
    args = parser.parse_args()
    try:
        if args.command == "validate":
            command_validate(args.path)
        elif args.command == "build":
            command_build(args.source, args.output)
        else:
            command_sign(args.source, args.output, args.private_key, args.valid_hours,
                         args.download_id, args.issued_at)
    except (OSError, ValueError, zipfile.BadZipFile, json.JSONDecodeError) as error:
        print(f"INVALID: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
