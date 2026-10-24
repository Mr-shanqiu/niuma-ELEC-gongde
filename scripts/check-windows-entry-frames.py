#!/usr/bin/env python3
"""Validate bounded real-entry timing evidence. CI does not grant hardware acceptance."""
import argparse
import json
import math
from pathlib import Path


def validate(data, require_hardware=False, require_dpi=None):
    def check(ok, message):
        if not ok:
            raise ValueError(message)

    check(data['schema'] in (1, 2) and data['captureComplete'] is True, 'incomplete capture')
    check(data['overflow'] == 0 and data['identityValid'] is True, 'overflow or identity change')
    byte_limit = (3 if data['schema'] == 2 else 2) * 1024 * 1024
    check(data['capacity'] == 8192 and 0 < data['bufferBytes'] <= byte_limit, 'buffer bound')
    check(data['scene'] in ('runtime.fixture.offwork-button', 'builtin.woodfish'), 'unknown scene')
    check(len(data['fingerprint']) == 64 and all(c in '0123456789abcdef' for c in data['fingerprint']), 'scene fingerprint')
    check(data['adapterKind'] in ('hardware', 'software'), 'unknown adapter')
    if require_hardware:
        check(data['adapterKind'] == 'hardware', 'hardware adapter required')
    if require_dpi is not None:
        check(data['dpi'] == require_dpi, 'unexpected DPI')
    check(data['gpuQueriesEnabled'] is False and data['readbackRequested'] is False and
          data['inputServiceDiagnostics'] is False, 'nonordinary measurement path')
    check(data['stoppedMonotonicMs'] > data['startedMonotonicMs'], 'invalid capture clock')
    elapsed = data['stoppedMonotonicMs'] - data['startedMonotonicMs']
    samples = data['samples']
    check(0 < len(samples) == data['samplesCount'] <= data['capacity'], 'sample count')
    check(data['endFramesPresented'] - data['startFramesPresented'] == len(samples), 'lost frame observations')
    fields = ['serial', 'relativeMs', 'wallMs', 'workMs', 'presentMs', 'readbackMs', 'drawMs',
              'regionMs', 'mathMs', 'supportAllMs', 'supportStrongMs', 'weakResolveMs',
              'serializeMs', 'nativeCreateMs', 'installMs', 'reuseComparisonMs', 'nativeRegionReused']
    if data['schema'] == 2:
        fields += ['sceneMs', 'textMs', 'texturesMs', 'assemblyMs', 'presenterMs', 'textChangedMask',
                   'meritBuildMs', 'meritRasterMs', 'meritMaskMs', 'plusBuildMs', 'plusRasterMs', 'plusMaskMs',
                   'clockBuildMs', 'clockRasterMs', 'clockMaskMs']
    check(data['fields'] == fields, 'unexpected sample schema')
    distributions = {k: [] for k in fields if k.endswith('Ms') and k != 'relativeMs'}
    previous_time = 0
    for i, row in enumerate(samples):
        check(len(row) == len(fields), 'incomplete sample')
        v = dict(zip(fields, row))
        check(v['serial'] == data['startFramesPresented'] + i + 1, 'nonconsecutive frame serial')
        check(previous_time <= v['relativeMs'] <= elapsed, 'frame outside capture window')
        previous_time = v['relativeMs']
        check(type(v['nativeRegionReused']) is bool, 'missing reuse state')
        for name in distributions:
            check(type(v[name]) in (int, float) and math.isfinite(v[name]) and v[name] >= 0,
                  'invalid timing: ' + name)
            distributions[name].append(v[name])
        check(v['readbackMs'] == 0, 'unexpected readback')
        check(abs(v['workMs'] + v['presentMs'] + v['readbackMs'] - v['wallMs']) < .00001,
              'frame subtraction inconsistent')
        check(v['supportAllMs'] + v['supportStrongMs'] + v['weakResolveMs'] <= v['mathMs'] + .05,
              'region math scope inconsistent')
        check(sum(v[k] for k in ('mathMs', 'serializeMs', 'nativeCreateMs', 'installMs', 'reuseComparisonMs'))
              <= v['regionMs'] + .05, 'region parent scope inconsistent')
        check(v['regionMs'] + v['drawMs'] <= v['workMs'] + .05, 'work parent scope inconsistent')
        if data['schema'] == 2:
            check(type(v['textChangedMask']) is int and 0 <= v['textChangedMask'] <= 7, 'invalid text change mask')
            check(sum(v[k] for k in ('sceneMs', 'textMs', 'texturesMs', 'assemblyMs', 'presenterMs'))
                  <= v['wallMs'] + .05, 'display parent scope inconsistent')
            check(sum(v[k + 'BuildMs'] for k in ('merit', 'plus', 'clock')) <= v['textMs'] + .05,
                  'text update parent scope inconsistent')
            for i, slot in enumerate(('merit', 'plus', 'clock')):
                check(v[slot + 'RasterMs'] + v[slot + 'MaskMs'] <= v[slot + 'BuildMs'] + .05,
                      'text preparation parent scope inconsistent')
                if not (v['textChangedMask'] & (1 << i)):
                    check(all(v[slot + k] == 0 for k in ('BuildMs', 'RasterMs', 'MaskMs')), 'stale text timing')
    summary = {}
    for k, values in distributions.items():
        ordered = sorted(values)
        summary[k] = dict(samples=len(values), meanMs=sum(values) / len(values),
                          p95Ms=ordered[math.ceil(len(values) * .95) - 1],
                          p99Ms=ordered[math.ceil(len(values) * .99) - 1], maxMs=ordered[-1])
    return dict(valid=True, adapterKind=data['adapterKind'], dpi=data['dpi'], scene=data['scene'],
                elapsedMs=elapsed, samples=len(samples), bufferBytes=data['bufferBytes'],
                statistics=summary, meetsFrameWorkTarget=(summary['workMs']['p95Ms'] <= 4 and
                                                        summary['workMs']['p99Ms'] <= 8),
                hardwareAcceptanceGranted=False,
                meaning='Elapsed calls, not CPU execution or physical display latency; target is evaluated without granting full P4 acceptance')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('capture', type=Path)
    parser.add_argument('--require-hardware', action='store_true')
    parser.add_argument('--require-dpi', type=int)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    result = validate(json.loads(args.capture.read_text(encoding='utf-8-sig')),
                      args.require_hardware, args.require_dpi)
    rendered = json.dumps(result, ensure_ascii=False, indent=2) + '\n'
    if args.output:
        with args.output.open('x', encoding='utf-8') as stream:
            stream.write(rendered)
    print(rendered)
