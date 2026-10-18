#pragma once

#include <algorithm>
#include <cstdio>
#include <ctime>
#include <string>

namespace niuma {

struct OffworkSnapshot {
  bool valid = false;
  bool overtime = false;
  int targetMinutes = 18 * 60;
  int remainingSeconds = 0;
  int overtimeSeconds = 0;
  std::time_t sampledAt = 0;
  std::time_t targetAt = 0;
  std::time_t nextMidnightAt = 0;
  std::string dayKey;
};

inline bool OffworkLocalTime(std::time_t value, std::tm* result) {
#ifdef _WIN32
  return localtime_s(result, &value) == 0;
#else
  return localtime_r(&value, result) != nullptr;
#endif
}

inline std::string OffworkDuration(int seconds) {
  seconds = std::max(0, seconds);
  char text[32];
  std::snprintf(text, sizeof(text), "%02d:%02d:%02d", seconds / 3600,
                seconds / 60 % 60, seconds % 60);
  return text;
}

// Every display and daily record must use this same wall-clock snapshot.
// Sleeping, delayed timers and restarting never accumulate synthetic seconds.
inline OffworkSnapshot EvaluateOffwork(std::time_t now, int hour, int minute) {
  OffworkSnapshot result;
  std::tm local = {};
  if (!OffworkLocalTime(now, &local)) return result;
  hour = std::clamp(hour, 0, 23);
  minute = std::clamp(minute, 0, 59);
  result.targetMinutes = hour * 60 + minute;
  result.sampledAt = now;
  char day[32];
  if (!std::strftime(day, sizeof(day), "%Y-%m-%d", &local)) return result;
  result.dayKey = day;
  std::tm target = local;
  target.tm_hour = hour;
  target.tm_min = minute;
  target.tm_sec = 0;
  target.tm_isdst = -1;
  result.targetAt = std::mktime(&target);
  std::tm midnight = local;
  ++midnight.tm_mday;
  midnight.tm_hour = midnight.tm_min = midnight.tm_sec = 0;
  midnight.tm_isdst = -1;
  result.nextMidnightAt = std::mktime(&midnight);
  if (result.targetAt == static_cast<std::time_t>(-1) ||
      result.nextMidnightAt == static_cast<std::time_t>(-1)) return result;
  const double delta = std::difftime(now, result.targetAt);
  result.overtime = delta > 0;
  result.overtimeSeconds = static_cast<int>(std::clamp(delta, 0.0, 172800.0));
  result.remainingSeconds = static_cast<int>(std::clamp(-delta, 0.0, 172800.0));
  result.valid = true;
  return result;
}

// Only use this at an observed, continuously-running midnight transition.
// Wake/start/time-change handlers must discard their previous baseline first.
inline int OffworkFinalDaySeconds(const OffworkSnapshot& previous) {
  if (!previous.valid) return 0;
  return static_cast<int>(std::clamp(
      std::difftime(previous.nextMidnightAt - 1, previous.targetAt), 0.0, 172800.0));
}

}  // namespace niuma
