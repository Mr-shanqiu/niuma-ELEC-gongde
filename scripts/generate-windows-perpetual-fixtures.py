#!/usr/bin/env python3
"""Frozen signed Windows inputs and tamper derivatives, without any signing.

Parent-owned CI input: ci/windows-perpetual-fixtures/*.nmgpack. Optional frozen
inventory fixtures.json: {"files": [{"file": "sample.nmgpack", "sha256": "..."}]}.
Require perpetual V2 and already-expired timed V1 under actual trusted keys.
Retired/current key coverage is recorded, but missing coverage is nonblocking.
Only Python stdlib and Node built-in crypto are needed. No private keys or network.
"""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import shutil
import struct
import subprocess
import time
import zipfile
import zlib

# Verification-only SPKI, identical to the two production Windows public keys.
KEYS = {
    "legacy": "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEKsX8RSYB05zE4p7P+bYWleMceGcnQRoBJtPXtTUqbb1JuKb3bHrig2DxgK8huBeiLJ4FHfYX2dzBs7iZh2Iitw==",
    "current": "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEJFKz2+/PBkxM8gIiltNrIpmsYS5C6yZ8VUlC38V5smkh//SQENxv0P/epN8qUX1y0Xo7qDF83Qr84r0DrvJyfA==",
}
VERIFY_JS = r"""
const fs = require('node:fs'), crypto = require('node:crypto');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const matches = Object.entries(input.keys).filter(([name, der]) =>
  crypto.verify('sha256', Buffer.from(input.message, 'utf8'), {
    key: crypto.createPublicKey({key: Buffer.from(der, 'base64'), format: 'der', type: 'spki'}),
    dsaEncoding: 'ieee-p1363'
  }, Buffer.from(input.signature, 'hex'))).map(([name]) => name);
process.stdout.write(JSON.stringify(matches));
"""
HARNESS = r'''#include "appearance_pack.h"
#include <iostream>
#include <string>

bool Run(int argc, wchar_t** argv) {
  if (argc != 4) return false;
  const bool reject = std::wstring(argv[1]) == L"reject";
  niuma::AppearanceCatalog catalog;
  std::wstring error;
  std::string id;
  const bool installed = catalog.Install(argv[3], argv[2], &id, &error);
  if (reject) {
    const bool clean = !installed && id.empty() && catalog.packs().empty();
    niuma::AppearanceCatalog restored;
    const bool empty = restored.Reload(argv[2], &error) && restored.packs().empty();
    if (clean && empty) { std::cout << "IMPORT_REJECT_PASS\n"; return true; }
    std::cout << "IMPORT_REJECT_FAIL installed=" << installed << "\n";
    return false;
  }
  if (!installed || id.empty() || catalog.packs().size() != 1) return false;
  std::string again;
  if (!catalog.Install(argv[3], argv[2], &again, &error) || again != id || catalog.packs().size() != 1) return false;
  niuma::AppearanceCatalog restored;
  if (!restored.Reload(argv[2], &error) || restored.packs().size() != 1) return false;
  auto* pack = restored.Find(id);
  if (!pack || pack->layers.empty() || !pack->preview.image) return false;
  for (float phase : {0.0f, 0.5f, 1.0f}) {
    Gdiplus::Bitmap frame(240, 250, PixelFormat32bppARGB);
    Gdiplus::Graphics graphics(&frame);
    graphics.Clear(Gdiplus::Color(0, 0, 0, 0));
    niuma::DrawAppearancePack(graphics, *pack, phase);
    if (graphics.GetLastStatus() != Gdiplus::Ok) return false;
  }
  std::cout << "IMPORT_ACCEPT_PASS reimport=1 reload=1 render=1\n";
  return true;
}

int wmain(int argc, wchar_t** argv) {
  Gdiplus::GdiplusStartupInput input;
  ULONG_PTR token = 0;
  if (Gdiplus::GdiplusStartup(&token, &input, nullptr) != Gdiplus::Ok) return 3;
  const bool ok = Run(argc, argv); // Destroy catalog images before GDI+ shutdown.
  Gdiplus::GdiplusShutdown(token);
  return ok ? 0 : 1;
}
'''
SIDECAR_CMAKE = r'''cmake_minimum_required(VERSION 3.16)
project(NiumaPerpetualImporterAudit LANGUAGES C CXX)
if(NOT WIN32 OR NOT MSVC OR NOT NIUMA_REPO_ROOT)
  message(FATAL_ERROR "Windows MSVC and NIUMA_REPO_ROOT are required")
endif()
add_executable(niuma-perpetual-import-test
  importer-test.cpp
  "${NIUMA_REPO_ROOT}/src/windows/appearance_pack.cpp"
  "${NIUMA_REPO_ROOT}/third_party/miniz/miniz.c")
target_include_directories(niuma-perpetual-import-test PRIVATE
  "${NIUMA_REPO_ROOT}/src/windows" "${NIUMA_REPO_ROOT}/third_party/miniz")
target_compile_features(niuma-perpetual-import-test PRIVATE cxx_std_17)
target_compile_definitions(niuma-perpetual-import-test PRIVATE
  UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX MINIZ_NO_ARCHIVE_WRITING_APIS)
target_link_libraries(niuma-perpetual-import-test PRIVATE gdiplus ole32 shell32 bcrypt)
set_property(TARGET niuma-perpetual-import-test PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
target_compile_options(niuma-perpetual-import-test PRIVATE /W4 /permissive- /utf-8)
'''


def sha(body):
    return hashlib.sha256(body).hexdigest()


def read_pack(path):
    if path.is_symlink() or path.stat().st_size > 50 * 1024 * 1024:
        raise ValueError("fixture must be a bounded regular archive")
    with zipfile.ZipFile(path) as archive:
        infos = archive.infolist()
        names = [info.filename for info in infos]
        if not 2 <= len(names) <= 8 or len(set(names)) != len(names):
            raise ValueError("invalid fixture entries")
        if "manifest.json" not in names or any(
                "/" in name or "\\" in name or name in (".", "..") or
                (name != "manifest.json" and not name.endswith(".png")) for name in names):
            raise ValueError("fixture contains unexpected files")
        if sum(info.file_size for info in infos) > 50 * 1024 * 1024:
            raise ValueError("fixture uncompressed size exceeds bound")
        files = {info.filename: archive.read(info) for info in infos}
    if len(files["manifest.json"]) > 64 * 1024:
        raise ValueError("manifest exceeds bound")
    manifest = json.loads(files["manifest.json"].decode("utf-8"))
    license_data = manifest.get("license", {})
    mode = license_data.get("mode")
    keys = {"mode", "issued_at", "download_id", "content_sha256", "signature"}
    if mode == "timed":
        keys.add("import_before")
    if mode not in ("timed", "perpetual") or set(license_data) != keys:
        raise ValueError("not an unchanged signed delivery fixture")
    issued = license_data["issued_at"]
    if type(issued) is not int or not 1577836800 <= issued <= 4102444800:
        raise ValueError("invalid signed issue time")
    fields = [manifest["id"], manifest["version"], str(issued)]
    if mode == "timed":
        deadline = license_data["import_before"]
        if type(deadline) is not int or not issued < deadline <= min(issued + 86400, 4102444800):
            raise ValueError("invalid historical signed window")
        fields.append(str(deadline))
    fields += [license_data["download_id"], license_data["content_sha256"]]
    if any(not isinstance(value, str) or "\r" in value or "\n" in value for value in fields):
        raise ValueError("invalid signed message")
    digest = hashlib.sha256()
    for name in sorted(set(files) - {"manifest.json"}):
        body = files[name]
        digest.update(name.encode("utf-8") + b"\0" + len(body).to_bytes(8, "big") + body)
    if digest.hexdigest() != license_data["content_sha256"]:
        raise ValueError("signed content digest mismatch")
    prefix = ["NIUMA-PACK-LICENSE-V2", "perpetual"] if mode == "perpetual" else ["NIUMA-PACK-LICENSE-V1"]
    result = subprocess.run(["node", "-e", VERIFY_JS], input=json.dumps({
        "keys": KEYS, "message": "\n".join(prefix + fields),
        "signature": license_data["signature"]}), text=True, capture_output=True, timeout=15, check=True)
    anchors = json.loads(result.stdout)
    if len(anchors) != 1:
        raise ValueError("signature is not from an existing production trust anchor")
    return files, manifest, anchors[0]


def archive(path, files):
    with zipfile.ZipFile(path, "x", compression=zipfile.ZIP_DEFLATED) as output:
        for name, body in files.items():
            info = zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            output.writestr(info, body)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--signed-fixture-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--expected-version", required=True)
    args = parser.parse_args()
    root = args.repo_root.resolve()
    if (root / "VERSION").read_text().strip() != args.expected_version:
        raise ValueError("fixture version binding mismatch")
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=False)
    source = args.signed_fixture_dir
    if not source.is_absolute():
        source = root / source
    if source.is_symlink() or (source.exists() and not source.is_dir()):
        raise ValueError("signed fixture input must be a regular directory")
    pins = None
    if (source / "fixtures.json").is_file():
        pin_list = json.loads((source / "fixtures.json").read_text(encoding="utf-8"))["files"]
        pins = {entry["file"]: entry["sha256"] for entry in pin_list}
    # Only this explicit directory is eligible; never inspect private/local packs.
    candidates = sorted(source.glob("*.nmgpack"))
    if len(candidates) > 32:
        raise ValueError("too many fixture candidates; provide a bounded frozen directory")
    selected, records, rejected = {}, [], []
    now = int(time.time())
    for path in candidates:
        try:
            body_hash = sha(path.read_bytes()) if path.stat().st_size <= 50 * 1024 * 1024 else ""
            if pins is not None and pins.get(path.name) != body_hash:
                raise ValueError("fixture SHA256 does not match frozen input inventory")
            files, manifest, anchor = read_pack(path)
            license_data = manifest["license"]
            mode = license_data["mode"]
            if mode == "timed" and license_data["import_before"] >= now:
                raise ValueError("timed fixture is not already expired; do not change its dates")
            slot = mode + "-" + anchor
            if slot not in selected:
                selected[slot] = (path, files, manifest, body_hash)
                records.append({"source": str(path.relative_to(root)) if path.is_relative_to(root) else path.name,
                                "sha256": body_hash, "mode": mode, "anchor": anchor,
                                "issuedAt": license_data["issued_at"], "importBefore": license_data.get("import_before")})
        except (ValueError, OSError, KeyError, TypeError, zipfile.BadZipFile) as error:
            rejected.append({"file": path.name, "reason": str(error)})
    missing = []
    for label, predicate in (
            ("signed perpetual V2", lambda slot: slot.startswith("perpetual-")),
            ("unchanged already-expired timed V1", lambda slot: slot.startswith("timed-"))):
        if not any(predicate(slot) for slot in selected):
            missing.append(label)
    anchor_coverage = {anchor: sorted(slot for slot in selected if slot.endswith("-" + anchor))
                       for anchor in KEYS}
    coverage_gaps = [{"anchor": anchor, "blocking": False,
                      "reason": "No frozen production-signed fixture for this anchor",
                      "followup": "Parent/Poincare protocol evidence tracked separately; not executed by this generator"}
                     for anchor, slots in anchor_coverage.items() if not slots]
    receipt = {"schema": "gongde-windows-perpetual-fixtures.v1", "version": args.expected_version,
               "status": "BLOCKED_SIGNED_FIXTURES" if missing else "READY",
               "scope": "Frozen production-signed test inputs; negative derivatives only; no signing, private keys or network",
               "observedAt": now, "sources": records, "missing": missing,
               "requiredCases": ["perpetual_v2", "expired_v1"],
               "anchorCoverage": anchor_coverage, "coverageGaps": coverage_gaps,
               "rejectedCandidates": rejected, "cases": []}
    if rejected:
        raise ValueError("Explicit frozen input contains invalid fixtures: " + json.dumps(rejected))
    if not missing:
        for slot, (path, files, manifest, source_hash) in selected.items():
            filename = slot + ".nmgpack"
            shutil.copyfile(path, output / filename)
            if sha((output / filename).read_bytes()) != source_hash:
                raise ValueError("frozen input changed during preparation")
            receipt["cases"].append({"name": slot, "file": filename, "expect": "accept", "sha256": source_hash})
        slot = next(slot for slot in selected if slot.startswith("perpetual-"))
        _, original, manifest, source_hash = selected[slot]
        for mutation in ("signature", "signed-issued-at", "png-content", "mode-downgrade"):
            files = dict(original)
            altered = copy.deepcopy(manifest)
            license_data = altered["license"]
            if mutation == "signature":
                text = license_data["signature"]
                license_data["signature"] = ("1" if text[0] == "0" else "0") + text[1:]
            elif mutation == "signed-issued-at":
                license_data["issued_at"] += -1 if license_data["issued_at"] == 4102444800 else 1
            elif mutation == "mode-downgrade":
                license_data["mode"] = "timed"
                license_data["import_before"] = min(license_data["issued_at"] + 3600, 4102444800)
            else:
                name = manifest["preview"]
                png = files[name]
                if not png.startswith(b"\x89PNG\r\n\x1a\n") or png[-12:] != b"\0\0\0\0IEND\xaeB`\x82":
                    raise ValueError("need a standard valid PNG fixture for isolated digest tampering")
                # Valid ancillary chunk keeps the PNG decodable but changes its digest.
                chunk = b"tEXt" + b"audit\0tampered"
                files[name] = png[:-12] + struct.pack(">I", len(chunk) - 4) + chunk + struct.pack(">I", zlib.crc32(chunk) & 0xffffffff) + png[-12:]
            files["manifest.json"] = json.dumps(altered, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            filename = "reject-" + mutation + ".nmgpack"
            archive(output / filename, files)
            receipt["cases"].append({"name": "reject-" + mutation, "file": filename, "expect": "reject",
                                     "sha256": sha((output / filename).read_bytes()), "derivedFromSha256": source_hash})
        (output / "importer-test.cpp").write_text(HARNESS, encoding="ascii")
        (output / "CMakeLists.txt").write_text(SIDECAR_CMAKE, encoding="ascii")
    (output / "fixture-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": receipt["status"], "missing": missing, "cases": len(receipt["cases"])}))


if __name__ == "__main__":
    main()
