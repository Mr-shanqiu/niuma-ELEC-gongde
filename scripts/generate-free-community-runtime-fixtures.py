#!/usr/bin/env python3
"""Synthetic offline native fixtures, not published or reviewed community works."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import struct
import zlib
import zipfile


def png_chunk(kind, body):
    return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xffffffff)


def fixture_png(rgb):
    rows = bytearray()
    for y in range(64):
        rows.append(0)
        for x in range(64):
            visible = (x - 32) ** 2 + (y - 32) ** 2 <= 26 ** 2
            rows.extend((*rgb, 255) if visible else (0, 0, 0, 0))
    header = struct.pack(">IIBBBBB", 64, 64, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + png_chunk(b"IHDR", header)
            + png_chunk(b"IDAT", zlib.compress(bytes(rows))) + png_chunk(b"IEND", b""))


def archive(path, files):
    with zipfile.ZipFile(path, "x", compression=zipfile.ZIP_DEFLATED) as output:
        for name, body in files.items():
            info = zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100600 << 16
            output.writestr(info, body)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,79}", args.run_id):
        parser.error("run-id must be a bounded synthetic identifier")
    output = Path(args.output_dir).resolve()
    output.mkdir(mode=0o700, parents=False, exist_ok=False)
    creator = hashlib.sha256(args.run_id.encode("ascii")).hexdigest()[:32]
    records = []
    manifests = {}

    def pack(name, slug, schema, rgb, mutation=None):
        layer = {"image": "sample.png", "frame": [88, 48, 64, 64], "anchor": [0.5, 0.5],
                 "keyframes": [{"t": t, "x": 0, "y": 3 if t == 0.5 else 0,
                                "rotation": 2 if t == 0.5 else 0, "scale": 1, "alpha": 1,
                                **({"scale_y": 1} if schema == 3 else {})} for t in (0, 0.5, 1)]}
        if schema == 3:
            layer["interpolation"] = "smoothstep"
        manifest = {"schema_version": schema, "id": f"creator.{creator}.{slug}", "version": "1.0.0",
                    "name_zh": "Synthetic native acceptance " + slug, "name_en": "Synthetic native acceptance " + slug,
                    "author": "Synthetic acceptance fixture", "publisher": "community",
                    "review_id": hashlib.sha256((args.run_id + slug).encode("ascii")).hexdigest()[:32],
                    "canvas_width": 240, "canvas_height": 250, "preview": "sample.png", "plus_y": 174,
                    "layers": [layer]}
        png = fixture_png(rgb)
        if mutation == "reserved":
            manifest["id"] = "official.lucky-cat"
        elif mutation == "pending":
            manifest["review_id"] = "pending"
        elif mutation == "invalid-png":
            png = b"\x89PNG\r\n\x1a\n"
        file = output / name
        archive(file, {"manifest.json": json.dumps(manifest, separators=(",", ":")).encode("utf-8"), "sample.png": png})
        body = file.read_bytes()
        records.append({"file": name, "bytes": len(body), "sha256": hashlib.sha256(body).hexdigest(),
                        "id": manifest["id"], "schema": schema, "timedLicenseAbsent": "license" not in manifest,
                        "expected": "INITIAL_REJECTION" if mutation else "IMPORT_RENDER_REIMPORT",
                        "syntheticOnly": True})
        manifests[name] = manifest
        return file

    amber = pack("community-schema1.nmgpack", "accept-amber", 1, (213, 103, 56))
    green = pack("community-schema3.nmgpack", "accept-green", 3, (58, 107, 82))
    batch = output / "community-two-works.nmgpacks"
    archive(batch, {amber.name: amber.read_bytes(), green.name: green.read_bytes()})
    records.append({"file": batch.name, "bytes": batch.stat().st_size,
                    "sha256": hashlib.sha256(batch.read_bytes()).hexdigest(),
                    "ids": [manifests[amber.name]["id"], manifests[green.name]["id"]],
                    "expected": "TWO_IMPORTS_REIMPORT", "syntheticOnly": True})
    pack("negative-reserved-identity.nmgpack", "accept-amber", 1, (213, 103, 56), "reserved")
    pack("negative-pending-review.nmgpack", "accept-amber", 1, (213, 103, 56), "pending")
    pack("negative-invalid-png.nmgpack", "accept-amber", 1, (213, 103, 56), "invalid-png")
    receipt = {"schema": "gongde-free-community-native-fixtures.v1", "runId": args.run_id, "creatorId": creator,
               "scope": "Synthetic delivery-format fixtures only; no HTTP, SQL, COS, account or native execution", "files": records}
    (output / "fixture-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"directory": str(output), "fixtures": len(records), "syntheticOnly": True}))


if __name__ == "__main__":
    main()
