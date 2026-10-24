#pragma once

// Diagnostic executable only. Aggregate accounting, no heap contents, stacks,
// user input, heap walking, forced compaction, working-set trimming or tools.
#include <windows.h>
#include <psapi.h>
#include <cstdint>
#include <ostream>

namespace niuma::diagnostic {
struct HeapSummaryData {
  DWORD cb = sizeof(HeapSummaryData);
  SIZE_T allocated = 0, committed = 0, reserved = 0, maximumReserve = 0;
};
struct MemoryObservation {
  std::uint64_t tick = 0, privateBytes = 0, workingSetBytes = 0;
  std::uint64_t privateRegionCommitted = 0, mappedRegionCommitted = 0, imageRegionCommitted = 0;
  std::uint64_t regions = 0;
  DWORD processError = 0, regionError = 0, heapError = 0, heapCountError = 0;
  DWORD heapCount = 0;
  HeapSummaryData defaultHeap;
};

inline MemoryObservation ObserveMemory() {
  MemoryObservation out;
  out.tick = GetTickCount64();
  PROCESS_MEMORY_COUNTERS_EX counters{};
  counters.cb = sizeof(counters);
  if (GetProcessMemoryInfo(GetCurrentProcess(), reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&counters), sizeof(counters))) {
    out.privateBytes = counters.PrivateUsage;
    out.workingSetBytes = counters.WorkingSetSize;
  } else { out.processError = GetLastError(); if (!out.processError) out.processError = ERROR_GEN_FAILURE; }

  // Query aggregate address-space accounting, never read the regions' bytes.
  // It is not atomic with the heap/process snapshots and excludes driver-owned
  // memory outside the process. It is not expected to equal PrivateUsage.
  SYSTEM_INFO info{};
  GetSystemInfo(&info);
  const auto maximum = reinterpret_cast<std::uintptr_t>(info.lpMaximumApplicationAddress);
  std::uintptr_t address = 0;
  while (address <= maximum) {
    MEMORY_BASIC_INFORMATION region{};
    if (!VirtualQuery(reinterpret_cast<void*>(address), &region, sizeof(region))) {
      out.regionError = GetLastError();
      if (!out.regionError) out.regionError = ERROR_GEN_FAILURE;
      break;
    }
    ++out.regions;
    if (region.State == MEM_COMMIT) {
      if (region.Type == MEM_PRIVATE) out.privateRegionCommitted += region.RegionSize;
      if (region.Type == MEM_MAPPED) out.mappedRegionCommitted += region.RegionSize;
      if (region.Type == MEM_IMAGE) out.imageRegionCommitted += region.RegionSize;
    }
    const auto next = reinterpret_cast<std::uintptr_t>(region.BaseAddress) + region.RegionSize;
    if (next <= address) { out.regionError = ERROR_ARITHMETIC_OVERFLOW; break; }
    address = next;
  }
  out.heapCount = GetProcessHeaps(0, nullptr);
  if (!out.heapCount) { out.heapCountError = GetLastError(); if (!out.heapCountError) out.heapCountError = ERROR_GEN_FAILURE; }
  // Default process heap only: this does not account for all CRT/driver heaps.
  // Resolve at runtime so an unavailable observation is null, not a new import
  // requirement or a fabricated zero. No product binary includes this header.
  using Query = BOOL (WINAPI*)(HANDLE, DWORD, HeapSummaryData*);
  const auto query = reinterpret_cast<Query>(GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "HeapSummary"));
  if (!query) out.heapError = ERROR_CALL_NOT_IMPLEMENTED;
  else if (!query(GetProcessHeap(), 0, &out.defaultHeap)) {
    out.heapError = GetLastError(); if (!out.heapError) out.heapError = ERROR_GEN_FAILURE;
  }
  return out;
}

inline void WriteMemory(std::ostream& stream, const MemoryObservation& value) {
  const auto optional = [&](std::uint64_t number, DWORD error) {
    if (error) stream << "null";
    else stream << number;
  };
  stream << "{\"observedTickMs\":" << value.tick << ",\"privateBytes\":";
  optional(value.privateBytes, value.processError);
  stream << ",\"workingSetBytes\":"; optional(value.workingSetBytes, value.processError);
  stream << ",\"privateRegionCommittedBytes\":"; optional(value.privateRegionCommitted, value.regionError);
  stream << ",\"mappedRegionCommittedBytes\":"; optional(value.mappedRegionCommitted, value.regionError);
  stream << ",\"imageRegionCommittedBytes\":"; optional(value.imageRegionCommitted, value.regionError);
  stream << ",\"addressRegions\":"; optional(value.regions, value.regionError);
  stream << ",\"processHeapCount\":"; optional(value.heapCount, value.heapCountError);
  stream << ",\"defaultHeapAllocatedBytes\":"; optional(value.defaultHeap.allocated, value.heapError);
  stream << ",\"defaultHeapCommittedBytes\":"; optional(value.defaultHeap.committed, value.heapError);
  stream << ",\"defaultHeapReservedBytes\":"; optional(value.defaultHeap.reserved, value.heapError);
  stream << ",\"processError\":" << value.processError << ",\"regionError\":" << value.regionError
      << ",\"heapError\":" << value.heapError << ",\"heapCountError\":" << value.heapCountError << "}";
}
}  // namespace niuma::diagnostic
