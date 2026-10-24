#!/usr/bin/env python3
"""Build a separate private entry from the frozen optimized source, never its EXE.

Exact original source hash + single-match patches keep the legacy drawing,
input callbacks and saving intact. Only isolation/startup/observations differ.
"""
from pathlib import Path
import difflib
import hashlib
import io
import json
import subprocess
import sys
import tarfile

COMMIT = 'e56606506e55223934bea6224ef11a8dfc6b2c53'
APP_SHA = 'cc7ba5f4a89d34dcd3b0cee1682444f28b060840f091a79a269fe7421a990ab5'
root = Path(__file__).resolve().parents[1]
out = Path(sys.argv[1]).resolve()
if out.exists():
    raise SystemExit('Use a new, exclusively owned source directory')
raw = subprocess.check_output(['git', 'archive', '--format=tar', COMMIT,
    'CMakeLists.txt', 'VERSION', 'src', 'assets', 'third_party', 'scripts'], cwd=root)
out.mkdir(parents=True)
with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
    for member in archive:
        dest = (out / member.name).resolve()
        if not dest.is_relative_to(out) or not (member.isdir() or member.isfile()):
            raise RuntimeError('Archive contains an unsafe/non-source member')
        if member.isdir():
            dest.mkdir(parents=True, exist_ok=True)
        else:
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(archive.extractfile(member).read())
app = out / 'src/windows/app.cpp'
archive_app = app.read_bytes()
# Windows git archive may apply CRLF checkout conversion. Bind to the raw
# immutable Git blob and accept only this known newline-only archive change.
original = subprocess.check_output(['git', 'cat-file', 'blob', f'{COMMIT}:src/windows/app.cpp'], cwd=root)
assert hashlib.sha256(original).hexdigest() == APP_SHA
assert archive_app == original or archive_app.replace(b'\r\n', b'\n') == original
source = original.decode('utf-8')
patches = []
def once(before, after, purpose):
    global source
    assert source.count(before) == 1, purpose
    source = source.replace(before, after, 1)
    patches.append(purpose)

once('#include <cstdio>', '#include <cstdio>\n#include <filesystem>', 'private fixture path support')
once('constexpr wchar_t kWindowClass[] = L"NiuMaMeritWindow";',
     'constexpr wchar_t kWindowClass[] = L"NiuMaMeritWindow.RuntimeCandidate";', 'separate private window class')
once('  bool preview = false;\n  for (int index',
     '  bool preview = false;\n  bool automatic = false;\n  for (int index', 'private startup guard state')
once('    if (wcscmp(arguments[index], L"--reminder-ui-preview") == 0) preview = true;',
     '    if (wcscmp(arguments[index], L"--reminder-ui-preview") == 0) preview = true;\n'
     '    if (wcscmp(arguments[index], L"--runtime-candidate") == 0) isolated = preview = true;\n'
     '    if (lstrcmpiW(arguments[index], L"--autostart") == 0) automatic = true;', 'explicit private entry arguments')
once('  if (!isolated && !preview && rootLength == 0) return true;',
     '  if (!isolated && !preview && rootLength == 0) return false;', 'prohibit ordinary profile fallback')
once('  if (!isolated || !preview || rootLength == 0 ||',
     '  if (!isolated || !preview || automatic || rootLength == 0 ||', 'prohibit autostart')
once('  gReminderPreviewAcceptance = true;', '  gReminderPreviewAcceptance = false;', 'disable preview bubble and its automatic exit')
once('std::string ReadSelectedPackId() {',
     '#include "../../scripts/legacy-private-entry-observation.h"\n\nstd::string ReadSelectedPackId() {', 'private fixture and one-shot observations')
once('  std::wstring catalogError;\n  const bool catalogLoaded =',
     '  if (!PrepareLegacyEntryScenario()) {\n'
     '    ReleaseAllPngResources(); Gdiplus::GdiplusShutdown(gState.gdiplusToken);\n'
     '    ReleaseMutex(gState.mutex); CloseHandle(gState.mutex);\n'
     '    if (SUCCEEDED(comResult)) CoUninitialize();\n'
     '    return 3;\n'
     '  }\n  std::wstring catalogError;\n  const bool catalogLoaded =', 'validate same private fixture before ordinary preload')
once('  if (!gIsolatedAcceptance) {\n    ConfigureLaunchAtLogin();\n    RestartGlobalListeners();\n  }',
     '  if (!gIsolatedAcceptance) ConfigureLaunchAtLogin();\n'
     '  RestartGlobalListeners();\n  WriteLegacyEntryObservation();', 'start original UI-thread hooks without startup registration')
once('  UpdateLayeredWindow(\n      gState.window, screen, &destination, &size, memoryDc, &source,\n      RGB(0, 0, 0), &blend, ULW_ALPHA);',
     '  const BOOL legacySubmitted = UpdateLayeredWindow(\n      gState.window, screen, &destination, &size, memoryDc, &source,\n      RGB(0, 0, 0), &blend, ULW_ALPHA);\n'
     '  if (legacySubmitted) ++gLegacyEntryFrames; else ++gLegacyEntrySubmitFailures;', 'count original successful native submissions only')
once('  if (gState.keyboardHook != nullptr) {\n    UnhookWindowsHookEx(gState.keyboardHook);\n  }\n  if (gState.mouseHook != nullptr)',
     '  WriteLegacyEntryObservation(true);\n  if (gState.keyboardHook != nullptr) {\n    UnhookWindowsHookEx(gState.keyboardHook);\n  }\n  if (gState.mouseHook != nullptr)', 'snapshot before normal hook shutdown')
app.write_bytes(source.encode('utf-8'))
helper = root / 'scripts/legacy-private-entry-observation.h'
(out / 'scripts/legacy-private-entry-observation.h').write_bytes(helper.read_bytes())
(out / 'PRIVATE_ENTRY_DIFF.patch').write_text(''.join(difflib.unified_diff(
    original.decode().splitlines(True), source.splitlines(True), 'frozen/app.cpp', 'private/app.cpp')), encoding='utf-8')
(out / 'PRIVATE_ENTRY_BINDING.json').write_text(json.dumps({
    'sourceCommit': COMMIT, 'originalAppSha256': APP_SHA,
    'archivedAppSha256': hashlib.sha256(archive_app).hexdigest(),
    'archiveNewlineNormalizationOnly': archive_app != original,
    'privateAppSha256': hashlib.sha256(app.read_bytes()).hexdigest(),
    'helperSha256': hashlib.sha256(helper.read_bytes()).hexdigest(),
    'frozenExeModified': False, 'formalEntryUsed': False,
    'legacyRenderAndInputAlgorithmsChanged': False, 'permittedEntryAndObservationPatches': patches,
    'warning': 'Separate private harness; never describe as the unmodified frozen EXE.'
}, indent=2)+'\n', encoding='utf-8')
print(f'Prepared fixed {COMMIT[:7]} private source: {len(patches)} exact entry/observation patches; original EXE untouched')
