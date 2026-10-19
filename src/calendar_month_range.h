#pragma once

#include <algorithm>
#include <string_view>

namespace niuma {
// Gregorian calendar browsing spans actual local history through this month.
struct CalendarMonthRange {
  int first = 12;
  int last = 12;

  static int Month(int year, int month) { return year * 12 + month - 1; }
  CalendarMonthRange(int year = 1, int month = 1)
      : first(Month(year, month)), last(first) {}

  template <class Character>
  void IncludeRecordedDay(std::basic_string_view<Character> key) {
    if (key.size() != 10 || key[4] != '-' || key[7] != '-') return;
    int digits[8]{}, count = 0;
    for (std::size_t i = 0; i < key.size(); ++i) {
      if (i == 4 || i == 7) continue;
      if (key[i] < '0' || key[i] > '9') return;
      digits[count++] = static_cast<int>(key[i] - '0');
    }
    const int year = digits[0] * 1000 + digits[1] * 100 + digits[2] * 10 + digits[3];
    const int month = digits[4] * 10 + digits[5], day = digits[6] * 10 + digits[7];
    if (year < 1 || month < 1 || month > 12 || day < 1) return;
    constexpr int lengths[] = {31,28,31,30,31,30,31,31,30,31,30,31};
    const bool leap = year % 400 == 0 || (year % 4 == 0 && year % 100 != 0);
    if (day > lengths[month - 1] + (month == 2 && leap ? 1 : 0)) return;
    first = std::min(first, Month(year, month));
  }

  int Clamp(int month) const { return std::clamp(month, first, last); }
  bool CanShift(int month, int delta) const {
    return delta == -1 ? month > first : delta == 1 && month < last;
  }
  int Shift(int month, int delta) const {
    month = Clamp(month);
    return CanShift(month, delta) ? month + delta : month;
  }
};
}  // namespace niuma
