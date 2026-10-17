#!/usr/bin/env python3
"""Compile the current bilingual reminder workbooks into a strict runtime catalog."""

import argparse
import base64
import datetime as dt
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

NS = {
    "m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}
EXCEL_EPOCH = dt.date(1899, 12, 30)
SIGNING_DOMAIN = b"NMG-TEXT-v1\0"


class WorkbookRow(dict):
    def __init__(self, *args, formula_columns=(), **kwargs):
        super().__init__(*args, **kwargs)
        self.formula_columns = set(formula_columns)


def workbook_sheets(path):
    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        relationships = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        targets = {item.attrib["Id"]: item.attrib["Target"] for item in relationships}
        strings = []
        if "xl/sharedStrings.xml" in names:
            shared = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            strings = ["".join(node.text or "" for node in item.findall(".//m:t", NS))
                       for item in shared.findall("m:si", NS)]
        output = {}
        for sheet in workbook.findall("m:sheets/m:sheet", NS):
            target = targets[sheet.attrib[f"{{{NS['r']}}}id"]].lstrip("/")
            if not target.startswith("xl/"):
                target = "xl/" + target
            root = ET.fromstring(archive.read(target))
            rows = []
            for row in root.findall("m:sheetData/m:row", NS):
                values = WorkbookRow()
                formulas = {}
                for cell in row.findall("m:c", NS):
                    column = re.match(r"[A-Z]+", cell.attrib["r"]).group(0)
                    value_node = cell.find("m:v", NS)
                    value = "" if value_node is None else value_node.text or ""
                    if cell.attrib.get("t") == "s" and value:
                        value = strings[int(value)]
                    inline = cell.find("m:is", NS)
                    if inline is not None:
                        value = "".join(node.text or "" for node in inline.findall(".//m:t", NS))
                    values[column] = value
                    formula = cell.find("m:f", NS)
                    if formula is not None:
                        formulas[column] = formula.text or ""
                values.formula_columns = set(formulas)
                rows.append(values)
            output[sheet.attrib["name"]] = rows
        return output


def colnum(value):
    if not value:
        return 0
    hour, minute = value.split(":")
    result = int(hour) * 60 + int(minute)
    if not 0 <= result <= 1440:
        raise ValueError(f"invalid local time {value!r}")
    return result


def regions(value):
    parts = [part.strip().upper() for part in re.split(r"[;,，、]", value or "") if part.strip()]
    if "*" in parts:
        if parts != ["*"]:
            raise ValueError(f"wildcard mixed with region codes: {value!r}")
        return ["*"]
    if any(not re.fullmatch(r"[A-Z]{2}", part) for part in parts):
        raise ValueError(f"invalid region code: {value!r}")
    return sorted(set(parts))


def named_item_rows(rows, language):
    names = {
        "id": "稳定ID", "category": "分类", "tone": "语气",
        "original": "文案原稿" if language == "zh-CN" else "英文原稿",
        "edit": "修改稿" if language == "zh-CN" else "英文修改稿",
        "trigger": "活动触发", "overtime": "加班条件", "festival": "节日编码",
        "start": "开始时刻", "end": "结束时刻", "before": "节前天数", "after": "节后天数",
    }
    if language == "en":
        names["regions"] = "适用地区"
    headers = [(index, row) for index, row in enumerate(rows)
               if "稳定ID" in row.values()]
    if len(headers) != 1:
        raise ValueError(f"expected one named item header for {language}")
    header_index, header = headers[0]
    columns = {}
    for field, label in names.items():
        found = [column for column, value in header.items() if value == label]
        if len(found) != 1 or found[0] in getattr(header, "formula_columns", set()):
            raise ValueError(f"missing, repeated or formula header {label!r} for {language}")
        columns[field] = found[0]
    output = []
    prefix = "nm.zh." if language == "zh-CN" else "nm.en."
    for row in rows[header_index + 1:]:
        item = {field: row.get(column, "") for field, column in columns.items()}
        if not item["id"].startswith("nm.") and not item["original"] and not item["edit"]:
            continue  # Workbook notes/empty layout rows are not content rows.
        if not item["id"].startswith(prefix):
            raise ValueError(f"unexpected stable ID {item['id']!r} for {language}")
        if any(columns[field] in getattr(row, "formula_columns", set())
               for field in ("original", "edit")):
            raise ValueError(f"formula source text is not allowed for {item['id']}")
        output.append(item)
    return output


def make_item(row, language):
    item_id, category, tone = row["id"], row["category"], row["tone"]
    original, edit = row["original"], row["edit"]
    # Never trust an Excel cached formula result for the final/export columns.
    # Current user authorization includes every row regardless of review status.
    final = edit.strip() or original.strip()
    trigger, overtime, festival = row["trigger"], row["overtime"], row["festival"]
    start, end = row["start"], row["end"]
    before, after = row["before"], row["after"]
    item_regions = ["*"] if language == "zh-CN" else regions(row["regions"])

    if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", item_id) or not final:
        raise ValueError(f"missing id or final text for {language}: {item_id!r}")
    if category not in ("普通", "节日") or tone not in ("幽默", "温情"):
        raise ValueError(f"unknown category/tone for {item_id}: {category!r}/{tone!r}")
    if trigger == "两者均可":
        triggers = ["long_busy", "high_intensity"]
    elif trigger == "高强度":
        triggers = ["high_intensity"]
    elif trigger == "持续忙碌":
        triggers = ["long_busy"]
    else:
        raise ValueError(f"unknown trigger for {item_id}: {trigger!r}")
    if overtime not in ("不限", "必须加班"):
        raise ValueError(f"unknown overtime filter for {item_id}: {overtime!r}")
    item = {
        "id": item_id,
        "language": language,
        "category": "festival" if category == "节日" else "ordinary",
        "tone": "warm" if tone == "温情" else "humor",
        "text": final.strip(),
        "triggers": triggers,
        "requires_overtime": overtime == "必须加班",
        "local_time": {"start_minute": colnum(start), "end_minute": colnum(end)},
        "festival_id": festival or None,
        "before_days": int(before),
        "after_days": int(after),
        "regions": item_regions,
    }
    if not item_regions or not 0 <= item["before_days"] <= 7 or not 0 <= item["after_days"] <= 7:
        raise ValueError(f"invalid region list or festival offsets for {item_id}")
    if not 4 <= len(item["text"]) <= (80 if language == "zh-CN" else 160):
        raise ValueError(f"text length outside v1 limits for {item_id}: {len(item['text'])}")
    if item["local_time"]["start_minute"] >= item["local_time"]["end_minute"]:
        raise ValueError(f"invalid local-time interval for {item_id}")
    return item


def calendar_records(path, language):
    sheets = workbook_sheets(path)
    if language == "zh-CN":
        meta_rows = sheets["节日规则"]
        date_rows = sheets["离线日期表"]
        metadata = {r.get("A", ""): r for r in meta_rows if r.get("A", "") in {
            "new_year", "lunar_eve", "spring_festival", "lantern", "labor_day",
            "dragon_boat", "mid_autumn", "national_day"}}
        year_column = "A"
        id_column, date_column = "B", "D"
    else:
        meta_rows = sheets["节日与地区"]
        date_rows = sheets["离线日期表"]
        metadata = {r.get("A", ""): r for r in meta_rows if r.get("A", "").startswith("en.")}
        year_column = "A"
        id_column, date_column = "B", "E"

    dates_by_id = {}
    for row in date_rows:
        item_id = row.get(id_column, "")
        year = row.get(year_column, "")
        value = row.get(date_column, "")
        if not item_id or not re.fullmatch(r"\d{4}", year):
            continue
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            date_value = dt.date.fromisoformat(value)
        else:
            date_value = EXCEL_EPOCH + dt.timedelta(days=int(float(value)))
        if date_value.year != int(year):
            raise ValueError(f"calendar year mismatch: {item_id} {year} {date_value}")
        dates_by_id.setdefault(item_id, {})[year] = date_value.isoformat()

    calendars = []
    for item_id, row in metadata.items():
        if language == "zh-CN":
            rule = row.get("C", "")
            if rule.startswith("每年"):
                month, day = (int(piece) for piece in re.findall(r"\d+", rule)[-2:])
                kind = "annual_gregorian"
            else:
                month = day = None
                kind = "date_table"
        else:
            rule = row.get("D", "")
            if rule == "annual_gregorian":
                md = re.findall(r"\d+", row.get("E", ""))
                if len(md) < 2:
                    raise ValueError(f"cannot parse annual date rule for {item_id}: {row.get('E')}")
                month, day = int(md[0]), int(md[1])
                kind = "annual_gregorian"
            else:
                month = day = None
                kind = "date_table"
        calendar = {"id": item_id, "language": language, "type": kind}
        if month is not None:
            calendar.update({"month": month, "day": day})
        else:
            calendar["dates"] = dates_by_id.get(item_id, {})
            if not calendar["dates"]:
                raise ValueError(f"no offline dates for calendar {item_id}")
        calendars.append(calendar)
    return calendars


def raw_ecdsa_signature(der):
    """Convert strict DER ECDSA integers into the protocol's 32-byte r||s."""
    cursor = 0
    if len(der) < 8 or der[cursor] != 0x30:
        raise ValueError("OpenSSL returned an invalid ECDSA signature")
    cursor += 1
    sequence_length = der[cursor]
    cursor += 1
    if sequence_length != len(der) - cursor:
        raise ValueError("OpenSSL returned an invalid ECDSA sequence")
    values = []
    for _ in range(2):
        if cursor + 2 > len(der) or der[cursor] != 0x02:
            raise ValueError("OpenSSL returned an invalid ECDSA scalar")
        cursor += 1
        length = der[cursor]
        cursor += 1
        if length == 0 or cursor + length > len(der):
            raise ValueError("OpenSSL returned an invalid ECDSA scalar length")
        value = der[cursor:cursor + length]
        cursor += length
        if value[0] & 0x80:
            raise ValueError("OpenSSL returned a negative ECDSA scalar")
        if len(value) > 1 and value[0] == 0:
            if not value[1] & 0x80:
                raise ValueError("OpenSSL returned a non-canonical ECDSA scalar")
            value = value[1:]
        if len(value) > 32 or not any(value):
            raise ValueError("OpenSSL returned an out-of-range ECDSA scalar")
        values.append(value.rjust(32, b"\0"))
    if cursor != len(der):
        raise ValueError("OpenSSL returned trailing ECDSA signature data")
    return values[0] + values[1]


def sign_catalog(payload, key_path, key_id):
    if not re.fullmatch(r"[a-z0-9.-]{1,64}", key_id):
        raise ValueError("key_id must contain 1-64 lowercase letters, digits, dots or hyphens")
    key_path = key_path.expanduser().resolve(strict=True)
    if os.name != "nt" and stat.S_IMODE(key_path.stat().st_mode) & 0o077:
        raise ValueError("the signing key file must be readable only by its owner (mode 0600)")
    curve = subprocess.run(
        ["openssl", "pkey", "-in", str(key_path), "-text", "-noout"],
        capture_output=True, text=True, check=False)
    if curve.returncode != 0 or not any(marker in curve.stdout for marker in
                                        ("ASN1 OID: prime256v1", "NIST CURVE: P-256")):
        raise ValueError("signing key must be an OpenSSL-readable P-256 private key")
    signed_message = SIGNING_DOMAIN + payload
    signed = subprocess.run(
        ["openssl", "dgst", "-sha256", "-sign", str(key_path)],
        input=signed_message, capture_output=True, check=False)
    if signed.returncode != 0:
        raise ValueError("OpenSSL could not sign the catalog payload")
    signature = raw_ecdsa_signature(signed.stdout)
    envelope = {
        "format": "nmgtext-envelope-v1",
        "key_id": key_id,
        "payload_b64": base64.b64encode(payload).decode("ascii"),
        "signature_b64": base64.b64encode(signature).decode("ascii"),
    }
    encoded = (json.dumps(envelope, ensure_ascii=True, separators=(",", ":")) + "\n").encode("utf-8")
    if len(encoded) > 2 * 1024 * 1024:
        raise ValueError("signed catalog exceeds the 2 MiB envelope limit")
    return encoded


def validate_publication(catalog, previous=None, copy_edit_ids=()):
    version = catalog["content_version"]
    if type(version) is not int or not 1 <= version <= 0xFFFFFFFF:
        raise ValueError("content_version must be a positive uint32 integer")
    calendar_version = catalog["calendar_version"]
    if not isinstance(calendar_version, str) or not 1 <= len(calendar_version.encode("utf-8")) <= 64:
        raise ValueError("calendar_version must contain 1-64 UTF-8 bytes")
    ids = [item["id"] for item in catalog["items"]]
    if len(ids) != len(set(ids)) or not 1 <= len(ids) <= 3000:
        raise ValueError("catalog must contain 1-3000 unique item IDs")
    counts = {language: sum(item["language"] == language for item in catalog["items"])
              for language in ("zh-CN", "en")}
    if version == 1 and counts != {"zh-CN": 800, "en": 800}:
        raise ValueError(f"initial catalog must include all approved 800 lines per language: {counts}")
    if not all(counts.values()) or sum(counts.values()) != len(ids):
        raise ValueError("catalog must contain both supported languages only")
    acknowledgments = set(copy_edit_ids)
    if previous is None:
        if version != 1:
            raise ValueError("updates require --previous-catalog for version/ID continuity checks")
        if acknowledgments:
            raise ValueError("copy-edit IDs require a previous catalog")
        return {"copy_edited_ids": [], "retired_ids": []}
    if (previous.get("schema_version") != 2 or
            previous.get("catalog_id") != catalog["catalog_id"] or
            type(previous.get("content_version")) is not int or
            not 1 <= previous["content_version"] < version):
        raise ValueError("previous catalog must match schema/catalog ID and have a lower version")
    previous_items = previous.get("items")
    if not isinstance(previous_items, list) or any(
            not isinstance(item, dict) or not isinstance(item.get("id"), str) or
            not isinstance(item.get("text"), str) for item in previous_items):
        raise ValueError("previous catalog has invalid item IDs/text")
    old = {item["id"]: item for item in previous_items}
    if len(old) != len(previous_items):
        raise ValueError("previous catalog repeats an item ID")
    changed = {item["id"] for item in catalog["items"]
               if item["id"] in old and item["text"] != old[item["id"]]["text"]}
    if changed != acknowledgments:
        missing = sorted(changed - acknowledgments)
        extra = sorted(acknowledgments - changed)
        raise ValueError(f"changed text needs explicit minor-copy-edit acknowledgment; "
                         f"substantive new sentences need new IDs. missing={missing}, unused={extra}")
    return {"copy_edited_ids": sorted(changed), "retired_ids": sorted(set(old) - set(ids))}


def read_previous_catalog(path):
    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"duplicate JSON key in previous catalog: {key}")
            result[key] = value
        return result
    value = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique_object)
    if not isinstance(value, dict):
        raise ValueError("previous catalog must be a JSON object")
    return value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--chinese-workbook", required=True, type=Path)
    parser.add_argument("--english-workbook", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--content-version", type=int, default=1,
                        help="positive uint32 content version; updates must increase it")
    parser.add_argument("--calendar-version", default="2026-2040-v1",
                        help="calendar data version, 1-64 UTF-8 bytes")
    parser.add_argument("--previous-catalog", type=Path,
                        help="previous complete runtime JSON; required for versions above 1")
    parser.add_argument("--copy-edit-id", action="append", default=[],
                        help="ID explicitly reviewed as a minor text edit; repeat per ID. "
                             "Substantive replacement sentences must receive new IDs")
    parser.add_argument("--header", type=Path,
                        help="also emit a compiled, offline C++ catalog header")
    parser.add_argument("--signing-key", type=Path,
                        help="P-256 publisher key, stored outside the repository")
    parser.add_argument("--key-id", help="trusted publisher key ID")
    parser.add_argument("--envelope-output", type=Path,
                        help="write a signed .nmgtext envelope")
    args = parser.parse_args()

    signing_args = (args.signing_key, args.key_id, args.envelope_output)
    if any(signing_args) and not all(signing_args):
        raise ValueError("--signing-key, --key-id and --envelope-output must be supplied together")

    chinese_sheets = workbook_sheets(args.chinese_workbook)
    english_sheets = workbook_sheets(args.english_workbook)
    chinese_rows = named_item_rows(chinese_sheets["文案总表"], "zh-CN")
    english_rows = named_item_rows(english_sheets["英文总表"], "en")
    items = [make_item(row, "zh-CN") for row in chinese_rows]
    items.extend(make_item(row, "en") for row in english_rows)
    ids = [item["id"] for item in items]
    if len(ids) != len(set(ids)):
        raise ValueError("duplicate reminder IDs")
    holidays = calendar_records(args.chinese_workbook, "zh-CN")
    holidays.extend(calendar_records(args.english_workbook, "en"))
    known = {holiday["id"] for holiday in holidays}
    for item in items:
        if item["category"] == "festival" and item["festival_id"] not in known:
            raise ValueError(f"unknown festival id for {item['id']}: {item['festival_id']}")
        if item["category"] == "ordinary" and item["festival_id"] is not None:
            raise ValueError(f"ordinary item has festival id: {item['id']}")

    catalog = {
        "schema_version": 2,
        "catalog_id": "official.multilingual",
        "content_version": args.content_version,
        "calendar_version": args.calendar_version,
        "calendar_year_start": 2026,
        "calendar_year_end": 2040,
        "languages": ["zh-CN", "en"],
        "items": items,
        "calendars": holidays,
    }
    publication = validate_publication(catalog,
        read_previous_catalog(args.previous_catalog) if args.previous_catalog else None,
        args.copy_edit_id)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    payload = (json.dumps(catalog, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    if len(payload) > 1024 * 1024:
        raise ValueError("catalog payload exceeds the 1 MiB limit; no rows were dropped")
    args.output.write_bytes(payload)
    if args.header:
        def cpp_string(value):
            return json.dumps(value, ensure_ascii=False)

        lines = [
            "// Generated by scripts/build-reminder-catalog.py; do not edit by hand.",
            "#pragma once", "", "#include <cstddef>", "",
            "namespace niuma::reminder {",
            "struct CatalogItem { const char* id; const char* language; const char* category; const char* tone; const char* text; unsigned triggers; bool requires_overtime; int start_minute; int end_minute; const char* festival_id; int before_days; int after_days; const char* regions; };",
            "struct Calendar { const char* id; const char* language; const char* type; int month; int day; const char* dates; };",
            "struct CatalogView { const CatalogItem* items; std::size_t item_count; const Calendar* calendars; std::size_t calendar_count; unsigned content_version; };",
            "inline constexpr CatalogItem kCatalogItems[] = {"
        ]
        for item in items:
            triggers = (1 if "long_busy" in item["triggers"] else 0) | (2 if "high_intensity" in item["triggers"] else 0)
            lines.append("  {" + ", ".join([
                cpp_string(item["id"]), cpp_string(item["language"]),
                cpp_string(item["category"]), cpp_string(item["tone"]),
                cpp_string(item["text"]), str(triggers),
                "true" if item["requires_overtime"] else "false",
                str(item["local_time"]["start_minute"]),
                str(item["local_time"]["end_minute"]),
                cpp_string(item["festival_id"] or ""),
                str(item["before_days"]), str(item["after_days"]),
                cpp_string("|".join(item["regions"]))
            ]) + "},")
        lines.append("};")
        lines.append("inline constexpr std::size_t kCatalogItemCount = sizeof(kCatalogItems) / sizeof(kCatalogItems[0]);")
        lines.append("inline constexpr Calendar kCalendars[] = {")
        for holiday in holidays:
            dates = ";".join(f"{year}={date}" for year, date in sorted(holiday.get("dates", {}).items()))
            lines.append("  {" + ", ".join([
                cpp_string(holiday["id"]), cpp_string(holiday["language"]),
                cpp_string(holiday["type"]), str(holiday.get("month", 0)),
                str(holiday.get("day", 0)), cpp_string(dates)
            ]) + "},")
        lines.extend(["};", "inline constexpr std::size_t kCalendarCount = sizeof(kCalendars) / sizeof(kCalendars[0]);", "inline constexpr CatalogView kBuiltinCatalogView{kCatalogItems, kCatalogItemCount, kCalendars, kCalendarCount, " + str(catalog["content_version"]) + "};", "}  // namespace niuma::reminder", ""])
        args.header.parent.mkdir(parents=True, exist_ok=True)
        args.header.write_text("\n".join(lines), encoding="utf-8")
    if args.envelope_output:
        envelope = sign_catalog(payload, args.signing_key, args.key_id)
        args.envelope_output.parent.mkdir(parents=True, exist_ok=True)
        args.envelope_output.write_bytes(envelope)
    print(f"wrote {len(items)} lines and {len(holidays)} calendars to {args.output}")
    if args.previous_catalog:
        print("publication continuity: " + json.dumps(publication, ensure_ascii=True))
    if args.envelope_output:
        print(f"signed official catalog version {catalog['content_version']} to {args.envelope_output}")


if __name__ == "__main__":
    try:
        main()
    except (KeyError, ValueError, OSError, zipfile.BadZipFile) as exc:
        print(f"catalog generation failed: {exc}", file=sys.stderr)
        sys.exit(1)
