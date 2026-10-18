#!/usr/bin/env python3
"""Create an isolated small-builtin import candidate without editing product sources."""

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
    # Read-only status in the acceptance snapshot makes the imported active
    # library visible. The importer, verifier, activity and input code stay intact.
    replace_once(source / "src/macos/app.mm", "  if (_reminderCatalogCommitUncertain) {", '''  const auto acceptanceView = _reminderCatalog
      ? _reminderCatalog->view() : niuma::reminder::kBuiltinCatalogView;
  unsigned long acceptanceChinese = 0, acceptanceEnglish = 0;
  for (std::size_t index = 0; index < acceptanceView.item_count; ++index) {
    if (std::strcmp(acceptanceView.items[index].language, "zh-CN") == 0) ++acceptanceChinese;
    if (std::strcmp(acceptanceView.items[index].language, "en") == 0) ++acceptanceEnglish;
  }
  aboutText = [aboutText stringByAppendingFormat:UiText(
      @"\\n【仅验收候选】当前文案库：%@ · v%u · 中文 %lu / 英文 %lu",
      @"\\n[Acceptance only] Active messages: %@ · v%u · Chinese %lu / English %lu"),
      _reminderCatalog ? UiText(@"已导入", @"Imported") : UiText(@"内置", @"Built in"),
      acceptanceView.content_version, acceptanceChinese, acceptanceEnglish];
  if (_reminderCatalogCommitUncertain) {''')
    replace_once(source / "src/windows/app.cpp", "  if (gState.reminderCatalogCommitUncertain) {", '''  const auto acceptanceView = gState.reminderCatalog
      ? gState.reminderCatalog->view() : niuma::reminder::kBuiltinCatalogView;
  unsigned acceptanceChinese = 0, acceptanceEnglish = 0;
  for (std::size_t index = 0; index < acceptanceView.item_count; ++index) {
    if (std::strcmp(acceptanceView.items[index].language, "zh-CN") == 0) ++acceptanceChinese;
    if (std::strcmp(acceptanceView.items[index].language, "en") == 0) ++acceptanceEnglish;
  }
  text += UiText(L"\\n【仅验收候选】当前文案库：", L"\\n[Acceptance only] Active messages: ");
  text += gState.reminderCatalog ? UiText(L"已导入", L"Imported") : UiText(L"内置", L"Built in");
  text += L" · v" + std::to_wstring(acceptanceView.content_version) +
      UiText(L" · 中文 ", L" · Chinese ") + std::to_wstring(acceptanceChinese) +
      UiText(L" / 英文 ", L" / English ") + std::to_wstring(acceptanceEnglish);
  if (gState.reminderCatalogCommitUncertain) {''')
    # The Windows production harness requires a timed preview. Permit manual
    # isolated UI only in this snapshot, keeping the same private/empty-root gate.
    replace_once(source / "src/windows/app.cpp", "  if (!isolated || !preview || rootLength == 0 ||",
                 "  if (!isolated || rootLength == 0 ||")
    replace_once(source / "src/windows/app.cpp", "  gReminderPreviewAcceptance = true;",
                 "  gReminderPreviewAcceptance = preview;")
    modified = {name: hashlib.sha256((source / name).read_bytes()).hexdigest()
                for name, sha in original.items()
                if hashlib.sha256((source / name).read_bytes()).hexdigest() != sha}
    if set(modified) != {"src/reminder_catalog_data.h", "src/macos/app.mm", "src/windows/app.cpp"}:
        raise ValueError("unexpected acceptance source changes")
    manifest = {"kind": "small-builtin-import-acceptance-only", "source_commit": commit,
                "builtin_counts": {"zh-CN": 20, "en": 20},
                "full_counts": dict(counts), "content_version": full["content_version"],
                "ids": sorted(ids), "original_source_sha256": original,
                "acceptance_overlay_sha256": modified,
                "changed_behavior": ["40 built-in messages", "read-only active-library counts in About",
                                     "Windows manual isolated UI without the preview timer"],
                "production_assets_modified": False, "production_sources_modified": False,
                "launched": False, "installed": False, "published": False}
    (output / "SOURCE_BINDING.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
                                               encoding="utf-8")
    print(f"Prepared acceptance-only source: 20 Chinese + 20 English; full source remains 800 + 800. {output}")


if __name__ == "__main__":
    main()
