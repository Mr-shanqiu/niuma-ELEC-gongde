#!/usr/bin/env python3
"""Prepare private unsigned user-package fixtures from public repository artwork.

These are test packages with a distinct namespace/issuer. They are never
represented as licensed official deliveries or installed into a real profile.
The normal client package validator remains in use without test exceptions.
"""
import hashlib
import json
from pathlib import Path
import sys
import zipfile

root = Path(__file__).resolve().parents[1]
output = Path(sys.argv[1]).resolve()
output.mkdir(parents=True, exist_ok=False)
records = []
for slug in ('offwork-button', 'koi-bubbles'):
    source = root / 'assets/appearance-packs' / slug
    raw = (source / 'manifest.json').read_bytes()
    manifest = json.loads(raw)
    assert 'license' not in manifest, 'Only public source artwork is a fixture input'
    manifest['id'] = 'runtime.fixture.' + slug
    manifest['author'] = 'NiuMa private runtime acceptance'
    manifest['publisher'] = 'runtime-fixture'
    manifest['review_id'] = 'local-test-not-official-delivery'
    manifest['name_zh'] = '测试·' + manifest['name_zh']
    manifest['name_en'] = 'Test - ' + manifest['name_en']
    images = sorted({manifest['preview']} | {layer['image'] for layer in manifest['layers']})
    archive = output / (slug + '.nmgpack')
    members = []
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as package:
        package.writestr('manifest.json', json.dumps(manifest, ensure_ascii=False, separators=(',', ':')).encode())
        for name in images:
            assert Path(name).name == name and name.endswith('.png')
            data = (source / name).read_bytes()
            assert data[:8] == b'\x89PNG\r\n\x1a\n'
            package.writestr(name, data)
            members.append({'name': name, 'sha256': hashlib.sha256(data).hexdigest()})
    records.append({'file': archive.name, 'id': manifest['id'], 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
                    'sourceManifestSha256': hashlib.sha256(raw).hexdigest(), 'artwork': members})
(output / 'fixture-bindings.json').write_text(json.dumps({'scope': 'private user-package fixtures, not official licensed deliveries',
    'validatorModified': False, 'productionPackages': False, 'packages': records}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(f'Prepared {len(records)} private packages using unchanged public artwork and the ordinary validator')
