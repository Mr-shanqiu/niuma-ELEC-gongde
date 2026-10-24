"""Validate new memory telemetry, without accepting the client's performance."""
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
stages = json.loads((root / "memory-stages.json").read_text())
expected = ["before-runtime", "scene-ready", "workload-complete-after-save",
            "window-closed-workers-stopped", "fixture-destroyed",
            "global-display-catalog-released", "gdi-com-uninitialized"]
assert [r["stage"] for r in stages["stages"]] == expected
groups = {
    "processError": ("privateBytes", "workingSetBytes"),
    "regionError": ("privateRegionCommittedBytes", "mappedRegionCommittedBytes",
                    "imageRegionCommittedBytes", "addressRegions"),
    "heapCountError": ("processHeapCount",),
    "heapError": ("defaultHeapAllocatedBytes", "defaultHeapCommittedBytes", "defaultHeapReservedBytes"),
}


def check(record):
    assert type(record["observedTickMs"]) is int and record["observedTickMs"] > 0
    for error, fields in groups.items():
        assert type(record[error]) is int and record[error] >= 0
        for field in fields:
            value = record[field]
            if record[error]:
                assert value is None, (error, field, value)
            else:
                assert type(value) is int and value >= 0, (field, value)
    if record["heapCountError"] == 0:
        assert record["processHeapCount"] > 0
    if record["regionError"] == 0:
        assert record["addressRegions"] > 0


for row in stages["stages"]:
    check(row["memory"])
samples = [json.loads(s) for s in (root / "samples.jsonl").read_text().splitlines() if s.strip()]
assert len(samples) >= 2
for row in samples:
    check(row["memoryObservation"])
assert not stages["defaultHeapIsAllProcessMemory"]
assert not stages["shortRunProvesLongRunStability"]
print(json.dumps({"memoryStages": len(expected), "memorySamples": len(samples),
                  "schemaValid": True, "productPerformanceAccepted": False}))
