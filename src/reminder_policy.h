#pragma once

#include "reminder_catalog_data.h"

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace niuma::reminder {

enum class Locale : std::uint8_t { Chinese, English };
enum class Overtime : std::uint8_t { Unknown, No, Yes };

struct SelectionContext {
  Locale locale = Locale::Chinese;
  const char* region = "*";
  unsigned trigger = 0;  // 1=long_busy, 2=high_intensity
  Overtime overtime = Overtime::Unknown;
  int year = 0;
  int month = 0;
  int day = 0;
  int minute_of_day = 0;
};

inline std::int64_t CivilDay(int year, unsigned month, unsigned day) {
  year -= month <= 2;
  const int era = (year >= 0 ? year : year - 399) / 400;
  const unsigned yoe = static_cast<unsigned>(year - era * 400);
  const unsigned doy = (153 * (month + (month > 2 ? -3 : 9)) + 2) / 5 + day - 1;
  const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return static_cast<std::int64_t>(era) * 146097 + doe - 719468;
}

inline bool ParseIsoDate(const char* text, int* year, int* month, int* day) {
  if (text == nullptr || std::strlen(text) != 10 ||
      std::sscanf(text, "%4d-%2d-%2d", year, month, day) != 3 ||
      *month < 1 || *month > 12 || *day < 1 || *day > 31) return false;
  char formatted[16] = {};
  std::snprintf(formatted, sizeof(formatted), "%04d-%02d-%02d", *year, *month, *day);
  if (std::strcmp(formatted, text) != 0) return false;
  static constexpr int month_days[] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
  const bool leap = (*year % 4 == 0 && *year % 100 != 0) || *year % 400 == 0;
  const int limit = *month == 2 && leap ? 29 : month_days[*month - 1];
  return *day <= limit;
}

inline const Calendar* FindCalendar(const char* id,
                                   const CatalogView& catalog = kBuiltinCatalogView) {
  for (std::size_t index = 0; index < catalog.calendar_count; ++index) {
    const Calendar& calendar = catalog.calendars[index];
    if (std::strcmp(calendar.id, id) == 0) return &calendar;
  }
  return nullptr;
}

inline bool CalendarDate(const Calendar& calendar, int year, std::int64_t* day) {
  if (std::strcmp(calendar.type, "annual_gregorian") == 0) {
    const std::int64_t value = CivilDay(year, static_cast<unsigned>(calendar.month),
                                        static_cast<unsigned>(calendar.day));
    // CivilDay normalizes invalid dates, so reject normalization (e.g. Feb 29
    // in a non-leap year) by round-tripping the compact input representation.
    int round_year = 0, round_month = 0, round_day = 0;
    char iso[16] = {};
    std::snprintf(iso, sizeof(iso), "%04d-%02d-%02d", year, calendar.month, calendar.day);
    if (!ParseIsoDate(iso, &round_year, &round_month, &round_day)) return false;
    const std::int64_t check = CivilDay(round_year, static_cast<unsigned>(round_month),
                                        static_cast<unsigned>(round_day));
    if (check != value) return false;
    *day = value;
    return true;
  }
  if (std::strcmp(calendar.type, "date_table") != 0) return false;
  const char* cursor = calendar.dates;
  while (*cursor != '\0') {
    char* end = nullptr;
    const long entry_year = std::strtol(cursor, &end, 10);
    if (end == cursor || *end != '=') return false;
    const char* date = end + 1;
    const char* separator = std::strchr(date, ';');
    const std::size_t length = separator == nullptr ? std::strlen(date) :
        static_cast<std::size_t>(separator - date);
    if (entry_year == year && length < 16) {
      char iso[16] = {};
      std::memcpy(iso, date, length);
      int parsed_year = 0, parsed_month = 0, parsed_day = 0;
      if (!ParseIsoDate(iso, &parsed_year, &parsed_month, &parsed_day) || parsed_year != year)
        return false;
      *day = CivilDay(parsed_year, static_cast<unsigned>(parsed_month),
                      static_cast<unsigned>(parsed_day));
      return true;
    }
    if (separator == nullptr) break;
    cursor = separator + 1;
  }
  return false;
}

inline bool RegionMatches(const char* encoded, const char* region) {
  if (std::strcmp(encoded, "*") == 0) return true;
  if (region == nullptr || std::strlen(region) != 2) return false;
  char sought[5] = {'|', region[0], region[1], '|', '\0'};
  std::string list("|");
  list += encoded;
  list += '|';
  return list.find(sought) != std::string::npos;
}

inline bool FestivalMatches(const CatalogItem& item, const SelectionContext& context,
                            const CatalogView& catalog) {
  if (std::strcmp(item.category, "ordinary") == 0) return item.festival_id[0] == '\0';
  const Calendar* calendar = FindCalendar(item.festival_id, catalog);
  if (calendar == nullptr) return false;
  const std::int64_t today = CivilDay(context.year, static_cast<unsigned>(context.month),
                                      static_cast<unsigned>(context.day));
  for (int year = context.year - 1; year <= context.year + 1; ++year) {
    std::int64_t anchor = 0;
    if (!CalendarDate(*calendar, year, &anchor)) continue;
    if (today >= anchor - item.before_days && today <= anchor + item.after_days) return true;
  }
  return false;
}

template <typename IsRecentlyShown>
std::vector<const CatalogItem*> EligibleItems(const SelectionContext& context,
                                               IsRecentlyShown is_recent,
                                               const CatalogView& catalog = kBuiltinCatalogView) {
  std::vector<const CatalogItem*> output;
  if (context.trigger != 1 && context.trigger != 2) return output;
  if (context.year < 1900 || context.year > 9999 || context.month < 1 ||
      context.month > 12 || context.day < 1 || context.day > 31 ||
      context.minute_of_day < 0 || context.minute_of_day >= 1440) return output;
  const char* language = context.locale == Locale::Chinese ? "zh-CN" : "en";
  for (std::size_t index = 0; index < catalog.item_count; ++index) {
    const CatalogItem& item = catalog.items[index];
    if (std::strcmp(item.language, language) != 0 || (item.triggers & context.trigger) == 0)
      continue;
    if (!RegionMatches(item.regions, context.region)) continue;
    if (item.requires_overtime && context.overtime != Overtime::Yes) continue;
    if (context.minute_of_day < item.start_minute || context.minute_of_day >= item.end_minute)
      continue;
    if (!FestivalMatches(item, context, catalog) || is_recent(item.id)) continue;
    output.push_back(&item);
  }
  return output;
}

// Index must return a uniformly distributed value in [0, upper_bound).
// Selection is performed only after candidate creation, never from an input hook.
template <typename Index>
const CatalogItem* SelectItem(const std::vector<const CatalogItem*>& candidates,
                              bool warm_used_today, Index index) {
  if (candidates.empty()) return nullptr;
  std::vector<const CatalogItem*> humor;
  std::vector<const CatalogItem*> warm;
  for (const CatalogItem* item : candidates) {
    if (std::strcmp(item->tone, "warm") == 0) {
      if (!warm_used_today) warm.push_back(item);
    } else {
      humor.push_back(item);
    }
  }
  std::vector<const CatalogItem*> tone_pool;
  if (humor.empty()) tone_pool = warm;
  else if (warm.empty()) tone_pool = humor;
  else tone_pool = index(100) < 20 ? warm : humor;
  if (tone_pool.empty()) return nullptr;

  std::vector<const CatalogItem*> ordinary;
  std::vector<const CatalogItem*> festival;
  for (const CatalogItem* item : tone_pool) {
    if (std::strcmp(item->category, "festival") == 0) festival.push_back(item);
    else ordinary.push_back(item);
  }
  if (ordinary.empty()) return festival[index(festival.size())];
  if (festival.empty()) return ordinary[index(ordinary.size())];
  if (index(100) >= 40) return ordinary[index(ordinary.size())];

  std::vector<const char*> festivals;
  for (const CatalogItem* item : festival) {
    bool known = false;
    for (const char* id : festivals)
      if (std::strcmp(id, item->festival_id) == 0) { known = true; break; }
    if (!known) festivals.push_back(item->festival_id);
  }
  const char* festival_id = festivals[index(festivals.size())];
  std::vector<const CatalogItem*> selected_festival;
  for (const CatalogItem* item : festival)
    if (std::strcmp(item->festival_id, festival_id) == 0)
      selected_festival.push_back(item);
  return selected_festival[index(selected_festival.size())];
}

}  // namespace niuma::reminder
