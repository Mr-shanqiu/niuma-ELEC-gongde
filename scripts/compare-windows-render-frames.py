"""Compare exact-control scenes and quantify the display-sized raster experiment.

The declared experimental acceptance limits are MAE <= 1 byte/channel and <= 1%
of pixels with any channel differing by >16. Controls must remain byte-identical.
These are image bounds, not a substitute for reviewing the retained screenshots.
"""
from pathlib import Path
import json
import struct
import sys
import zlib

root = Path(sys.argv[1])
before = json.loads((root / 'profile-before.json').read_text())
after = json.loads((root / 'profile-after.json').read_text())
assert len(before['scenes']) == len(after['scenes']) == 25

def png(path, width, height, pixels):
    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data))
    rows = b''.join(b'\0' + pixels[y*width*3:(y+1)*width*3] for y in range(height))
    path.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))

results = []
failures = []
for scene_index, (old, new) in enumerate(zip(before['scenes'], after['scenes'])):
    fields = ('appearance', 'countdown', 'dpi', 'animated')
    assert [old[k] for k in fields] == [new[k] for k in fields]
    assert len(old['pixelHashes']) == len(new['pixelHashes']) == 5
    for phase_index, (old_hash, new_hash) in enumerate(zip(old['pixelHashes'], new['pixelHashes'])):
        index = scene_index * 5 + phase_index
        row = {k: old[k] for k in fields}
        row.update(phase=phase_index, exact=old_hash == new_hash)
        if old_hash != new_hash:
            raw_old = (root / 'frames-before' / f'{index}.frame').read_bytes()
            raw_new = (root / 'frames-after' / f'{index}.frame').read_bytes()
            assert raw_old[:8] == raw_new[:8] and len(raw_old) == len(raw_new)
            width, height = struct.unpack('<II', raw_old[:8])
            a, b = raw_old[8:], raw_new[8:]
            error = sum(abs(x-y) for x, y in zip(a, b))
            significant = sum(max(abs(a[i+c]-b[i+c]) for c in range(4)) > 16 for i in range(0,len(a),4))
            row.update(meanAbsoluteChannelError=error / len(a), significantPixelFraction=significant/(width*height))
            if old['appearance'] != 'offwork' or row['meanAbsoluteChannelError'] > 1 or row['significantPixelFraction'] > .01:
                failures.append(row)
        # Keep actual-size, white-composited triptychs at every captured phase.
        if old['appearance'] == 'offwork' and old['dpi'] == 192 and old['animated'] and old['countdown']:
            raw_old = (root / 'frames-before' / f'{index}.frame').read_bytes()
            raw_new = (root / 'frames-after' / f'{index}.frame').read_bytes()
            width, height = struct.unpack('<II', raw_old[:8])
            a, b = raw_old[8:], raw_new[8:]
            pixels = bytearray()
            for y in range(height):
                for source in (a,b):
                    for x in range(width):
                        i=(y*width+x)*4
                        pixels.extend(min(255,source[i+c]+255-source[i+3]) for c in (2,1,0))
                for x in range(width):
                    i=(y*width+x)*4
                    pixels.extend(min(255,abs(a[i+c]-b[i+c])*4) for c in (2,1,0))
            png(root/f'comparison-phase-{phase_index}.png',width*3,height,pixels)
        results.append(row)
summary = {'scenes':25,'frames':len(results),'exactFrames':sum(row['exact'] for row in results),
    'experiment':'display-sized rasters; complete artwork pose reused independently of text',
    'limits':{'meanAbsoluteChannelError':1,'significantPixelFraction':.01,'significantThreshold':16},
    'failures':failures,'framesDetail':results,'physicalInputLatencyMeasured':False}
(root/'frame-comparison.json').write_text(json.dumps(summary,indent=2))
print(json.dumps({k:v for k,v in summary.items() if k != 'framesDetail'}))
assert not failures, 'Display-sized image quality/control check failed; review screenshots before accepting'
