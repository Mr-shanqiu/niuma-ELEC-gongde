"""Summarize bounded-resource behavior without claiming hours of stability."""
from pathlib import Path
import json
import statistics
import sys

path = Path(sys.argv[1]); data = json.loads(path.read_text())
assert data['completed'] and data['durationSeconds'] == 300
assert data['posted'] == data['handled'] == data['countDelta'] and data['persistedCountMatches']
assert data['postFailures'] == 0
summary = {'version':data['version'],'durationSeconds':data['durationSeconds'],
    'posted':data['posted'],'countDelta':data['countDelta'],
    'sourceReloads':data['sourceReloads'],'shapeOrDpiChanges':data['shapeOrDpiChanges'],
    'phases':{},'physicalTypingMeasured':False,'limitation':'Five minutes and repeated resource changes cannot prove stability over hours; matrix jobs use separate runners.'}
for phase, name in enumerate(('input','resourceChanges','idleRecovery')):
    rows = [row for row in data['samples'] if row['phase']==phase]
    assert len(rows) >= 15
    summary['phases'][name] = {
        'privateBytesMin':min(row['privateBytes'] for row in rows),
        'privateBytesMax':max(row['privateBytes'] for row in rows),
        'gdiMin':min(row['gdiObjects'] for row in rows),'gdiMax':max(row['gdiObjects'] for row in rows),
        'userMin':min(row['userObjects'] for row in rows),'userMax':max(row['userObjects'] for row in rows),
        'handlesMin':min(row['handles'] for row in rows),'handlesMax':max(row['handles'] for row in rows),
        'cpuOneCoreMeanPercent':statistics.mean(row['oneCoreCpuPercent'] for row in rows),
        'maxObservedPending':max(row['pending'] for row in rows),
        'queueP95MaxMs':max(row['queueCompletionP95Ms'] for row in rows),
        'frameMeanMs':statistics.mean(row['frameMeanMs'] for row in rows if row['frames']),
    }
steady = [row for row in data['samples'] if row['phase']==0 and row['elapsedSeconds']>=20]
for field in ('privateBytes','gdiObjects','handles','frameMeanMs','queueCompletionP95Ms'):
    summary['phases']['input'][field+'FirstThreeMean']=statistics.mean(row[field] for row in steady[:3])
    summary['phases']['input'][field+'LastThreeMean']=statistics.mean(row[field] for row in steady[-3:])
tail=[row for row in data['samples'] if row['phase']==2 and row['elapsedSeconds']>=220]
growth={field:statistics.mean(row[field] for row in tail[-3:])-statistics.mean(row[field] for row in tail[:3])
    for field in ('privateBytes','gdiObjects','userObjects','handles')}
summary['idleTailGrowth']=growth
summary['idleTailGatePassed']=(growth['privateBytes']<=2*1024*1024 and growth['gdiObjects']<=1
    and growth['userObjects']<=1 and growth['handles']<=2 and tail[-1]['pending']==0)
path.with_name(path.stem+'-summary.json').write_text(json.dumps(summary,indent=2))
print(json.dumps(summary,indent=2))
assert summary['idleTailGatePassed'], 'Resource growth continued in the idle recovery tail'
