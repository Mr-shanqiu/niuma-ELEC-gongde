#!/usr/bin/env python3
"""Verify fixed P0 inputs; inventory artwork sizes without decoding/private data."""
import hashlib
import json
from pathlib import Path
import re
import struct
import sys

root = Path(__file__).resolve().parents[1]
output = Path(sys.argv[1]).resolve()
output.mkdir(parents=True, exist_ok=True)
header = (root / 'scripts/runtime-p0-fixtures.h').read_text()
manifest_sha = re.search(r'kOffworkManifestSha256\[\]\s*=\s*"([0-9a-f]{64})"', header).group(1)
entries = re.findall(r'\{"(assets/[^"\n]+)",\s*(?:"([0-9a-f]{64})"|(kOffworkManifestSha256))\}', header)
assert len(entries) == 6, 'P0 must bind every pinned image and its geometry source'
bound = []
for path, digest, variable in entries:
    expected = manifest_sha if variable else digest
    actual = hashlib.sha256((root / path).read_bytes()).hexdigest()
    assert actual == expected, f'{path}: fixture no longer matches source; regenerate explicitly'
    bound.append({'path': path, 'sha256': actual})

def png(path):
    with path.open('rb') as stream:
        data = stream.read(24)
    assert data[:8] == b'\x89PNG\r\n\x1a\n', path
    width, height = struct.unpack('>II', data[16:24])
    return {'path': path.relative_to(root).as_posix(), 'width': width, 'height': height,
            'decodedBgraBytes': width * height * 4, 'fileBytes': path.stat().st_size}

packs = []
for path in sorted((root / 'assets/appearance-packs').glob('*/manifest.json')):
    data = json.loads(path.read_text())
    layers = data.get('layers', [])
    images = sorted({layer['image'] for layer in layers})
    if not images:
        continue
    record = {'id': data.get('id', path.parent.name), 'layers': len(layers),
              'images': [png(path.parent / image) for image in images]}
    record['allFullResolutionBytes'] = sum(image['decodedBgraBytes'] for image in record['images'])
    packs.append(record)
report = {'scope': 'public repository artwork only; excludes installed or customer packs',
          'pinnedFixtureInputs': bound,
          'builtins': [png(root / 'assets/woodfish.png'), png(root / 'assets/mallet.png')],
          'packs': packs,
          'maxSinglePackFullResolutionBytes': max((p['allFullResolutionBytes'] for p in packs), default=0),
          'sumAllPackFullResolutionBytes': sum(p['allFullResolutionBytes'] for p in packs),
          'compositionBuffers': [{'scalePercent': scale, 'twoBgraBuffersBytes': (240*scale//100)*(250*scale//100)*8}
                                 for scale in [100,150,200]],
          'budgetStatus': 'inventory, not a measured process memory bound'}
(output / 'runtime-p0-sources.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(f'P0 fixture: {len(bound)} fixed sources; {len(packs)} packs inventoried; max full decode {report["maxSinglePackFullResolutionBytes"] / 1048576:.2f} MiB')
