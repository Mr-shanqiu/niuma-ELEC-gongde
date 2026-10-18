#!/usr/bin/env python3
"""Prepare one small-builtin client for the complete reminder acceptance journey."""

import argparse
from collections import Counter
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import tarfile


def replace_once(path, old, new):
    text = path.read_text(encoding="utf-8")
    if text.count(old) != 1:
        raise ValueError(f"acceptance overlay anchor changed: {path.name}")
    path.write_text(text.replace(old, new), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ref", default="HEAD")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--revision", choices=("R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8"), default="R1")
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[1]
    output = args.output.resolve()
    allowed = repo / ".local-work/candidates"
    if allowed not in output.parents or output.exists():
        raise ValueError("output must be a new directory below .local-work/candidates")
    commit = subprocess.check_output(["git", "rev-parse", args.ref + "^{commit}"], cwd=repo,
                                     text=True).strip()
    includes = ["CMakeLists.txt", "VERSION", "src", "third_party/miniz",
                "scripts/build-macos.sh", "assets/woodfish.png", "assets/mallet.png",
                "assets/developer-douyin.png", "assets/appicon.ico", "assets/appicon.icns",
                "assets/reminders/official-multilingual-v1.json"]
    archive = subprocess.check_output(["git", "archive", commit, "--", *includes], cwd=repo)
    source = output / "source"
    source.mkdir(parents=True)
    original = {}
    with tarfile.open(fileobj=io.BytesIO(archive)) as files:
        for item in files:
            path = source / item.name
            if Path(item.name).is_absolute() or ".." in Path(item.name).parts:
                raise ValueError("unsafe source archive path")
            if item.isdir():
                path.mkdir(parents=True, exist_ok=True)
            elif item.isfile():
                data = files.extractfile(item).read()
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
                path.chmod(item.mode & 0o777)
                original[item.name] = hashlib.sha256(data).hexdigest()
            else:
                raise ValueError("source archive contains a non-regular member")
    catalog_path = source / "assets/reminders/official-multilingual-v1.json"
    full = json.loads(catalog_path.read_text(encoding="utf-8"))
    counts = Counter(i["language"] for i in full["items"])
    if counts != {"zh-CN": 800, "en": 800}:
        raise ValueError("source is not the complete current bilingual catalog")
    selected = []
    for language in ("zh-CN", "en"):
        for category, tone, size in (("ordinary", "humor", 12), ("ordinary", "warm", 4),
                                     ("festival", "humor", 3), ("festival", "warm", 1)):
            pool = [i for i in full["items"] if (i["language"], i["category"], i["tone"]) ==
                    (language, category, tone)]
            # Prefer ordinary messages usable without overtime configuration.
            pool.sort(key=lambda i: (i["requires_overtime"], i["id"]))
            if len(pool) < size:
                raise ValueError("source lacks the expected acceptance strata")
            selected.extend(pool[:size])
    ids = {i["id"] for i in selected}
    small = {**full, "items": [i for i in full["items"] if i["id"] in ids]}
    fixture = output / "fixtures"
    fixture.mkdir()
    (fixture / "small-builtin.json").write_text(json.dumps(small, ensure_ascii=False, indent=2) + "\n",
                                                encoding="utf-8")
    header_path = source / "src/reminder_catalog_data.h"
    header = header_path.read_text(encoding="utf-8")
    start = header.index("inline constexpr CatalogItem kCatalogItems[] = {\n")
    end = header.index("\n};", start)
    prefix, rows = header[:start], header[start:end].splitlines()
    kept = [rows[0]]
    found = set()
    for row in rows[1:]:
        match = re.match(r'\s+\{("(?:[^"\\]|\\.)*")\s*,', row)
        if not match:
            raise ValueError("unrecognized generated catalog header row")
        item_id = json.loads(match.group(1))
        if item_id in ids:
            kept.append(row)
            found.add(item_id)
    if found != ids or len(kept) != 41:
        raise ValueError("small JSON/header IDs disagree")
    header_path.write_text(prefix + "\n".join(kept) + header[end:], encoding="utf-8")
    # Keep About identical to production; catalog diagnostics do not belong in the UI.
    # The Windows production harness requires a timed preview. Permit manual
    # isolated UI only in this snapshot, keeping the same private/empty-root gate.
    replace_once(source / "src/windows/app.cpp", "  if (!isolated || !preview || rootLength == 0 ||",
                 "  if (!isolated || rootLength == 0 ||")
    replace_once(source / "src/windows/app.cpp", "  gReminderPreviewAcceptance = true;",
                 "  gReminderPreviewAcceptance = preview;")
    # Normal acceptance keeps the real data profile and global listeners. Match
    # macOS's listener-acceptance flag so testing cannot rewrite login startup.
    replace_once(source / "src/windows/app.cpp", "bool gReminderPreviewAcceptance = false;",
                 "bool gReminderPreviewAcceptance = false;\nbool gListenerAcceptance = false;")
    replace_once(source / "src/windows/app.cpp",
                 '    if (wcscmp(arguments[index], L"--reminder-ui-preview") == 0) preview = true;',
                 '    if (wcscmp(arguments[index], L"--reminder-ui-preview") == 0) preview = true;\n'
                 '    if (wcscmp(arguments[index], L"--listener-acceptance") == 0) gListenerAcceptance = true;')
    replace_once(source / "src/windows/app.cpp",
                 "    ConfigureLaunchAtLogin();\n    RestartGlobalListeners();",
                 "    if (!gListenerAcceptance) ConfigureLaunchAtLogin();\n    RestartGlobalListeners();")
    expected_modified = {"src/reminder_catalog_data.h", "src/windows/app.cpp"}
    if args.revision in ("R2", "R3", "R4", "R5", "R6", "R7", "R8"):
        replace_once(source / "src/windows/app.cpp",
                     '  return UiText(L"牛马电子功德", L"NiuMa Merit");',
                     f'  return UiText(L"牛马电子功德【综合验收·{args.revision}】", L"NiuMa Merit [Unified Acceptance {args.revision}]");')
        for name, label in (
                ("en", f"NiuMa Merit [Unified Acceptance {args.revision}]"),
                ("zh-Hans", f"牛马电子功德【综合验收·{args.revision}】"),
                ("zh-Hant", f"牛馬電子功德【綜合驗收·{args.revision}】")):
            relative = f"src/macos/{name}.lproj/InfoPlist.strings"
            path = source / relative
            text = path.read_text(encoding="utf-8")
            for key in ("CFBundleName", "CFBundleDisplayName"):
                text, count = re.subn(r'("' + key + r'"\s*=\s*)"[^"\n]*"',
                                      lambda match: match[1] + json.dumps(label, ensure_ascii=False), text)
                if count != 1:
                    raise ValueError("unexpected localized bundle label")
            path.write_text(text, encoding="utf-8")
            expected_modified.add(relative)
        relative = "src/macos/Info.plist.in"
        path = source / relative
        text = path.read_text(encoding="utf-8")
        for key in ("CFBundleName", "CFBundleDisplayName"):
            old = f"<key>{key}</key><string>NiuMa Merit</string>"
            if text.count(old) != 1:
                raise ValueError("unexpected bundle label")
            text = text.replace(old, f"<key>{key}</key><string>NiuMa Merit [Unified Acceptance {args.revision}]</string>")
        if args.revision in ("R7", "R8"):
            text = text.replace('<key>CFBundleVersion</key><string>904.0</string>',
                                f'<key>CFBundleVersion</key><string>904.{args.revision[1:]}</string>')
            text = text.replace('</dict>\n</plist>', f'<key>NiuMaInstallName</key><string>牛马电子功德-综合验收-20261019-{args.revision}.app</string>\n</dict>\n</plist>')
        path.write_text(text, encoding="utf-8")
        expected_modified.add(relative)
    modified = {name: hashlib.sha256((source / name).read_bytes()).hexdigest()
                for name, sha in original.items()
                if hashlib.sha256((source / name).read_bytes()).hexdigest() != sha}
    if set(modified) != expected_modified:
        raise ValueError("unexpected acceptance source changes")
    manifest = {"kind": "unified-reminder-acceptance", "revision": args.revision, "source_commit": commit,
                "builtin_counts": {"zh-CN": 20, "en": 20},
                "full_counts": dict(counts), "content_version": full["content_version"],
                "ids": sorted(ids), "original_source_sha256": original,
                "acceptance_overlay_sha256": modified,
                "changed_behavior": ["40 built-in messages",
                                     "Windows manual isolated UI without the preview timer",
                                     "Windows --listener-acceptance keeps real listeners/profile without rewriting login startup"],
                "production_assets_modified": False, "production_sources_modified": False,
                "launched": False, "installed": False, "published": False}
    (output / "SOURCE_BINDING.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
                                               encoding="utf-8")
    print(f"Prepared acceptance-only source: 20 Chinese + 20 English; full source remains 800 + 800. {output}")


if __name__ == "__main__":
    main()
