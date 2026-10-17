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
                values = {}
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


def make_item(row, language):
    if language == "zh-CN":
        item_id, category, tone, original, status, edit = (
            row.get("A", ""), row.get("B", ""), row.get("C", ""),
            row.get("D", ""), row.get("E", ""), row.get("F", ""))
        final = row.get("H", "") or edit or original
        trigger, overtime, festival = row.get("J", ""), row.get("K", ""), row.get("L", "")
        start, end, before, after = row.get("M", ""), row.get("N", ""), row.get("O", "0"), row.get("P", "0")
        item_regions = ["*"]
    else:
        item_id, category, tone, original, status, edit = (
            row.get("A", ""), row.get("B", ""), row.get("C", ""),
            row.get("D", ""), row.get("F", ""), row.get("G", ""))
        final = row.get("I", "") or edit or original
        trigger, overtime, festival = row.get("K", ""), row.get("L", ""), row.get("M", "")
        start, end, before, after = row.get("N", ""), row.get("O", ""), row.get("P", "0"), row.get("Q", "0")
        item_regions = regions(row.get("T", "*"))

    if not item_id or not final:
        raise ValueError(f"missing id or final text for {language} row {row}")
    # The user explicitly asked to include every current line, irrespective of
    # workbook review/export state. The status is intentionally not a filter.
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--chinese-workbook", required=True, type=Path)
    parser.add_argument("--english-workbook", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
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
    chinese_rows = [row for row in chinese_sheets["文案总表"] if row.get("A", "").startswith("nm.zh.")]
    english_rows = [row for row in english_sheets["英文总表"] if row.get("A", "").startswith("nm.en.")]
    if len(chinese_rows) != 800 or len(english_rows) != 800:
        raise ValueError(f"expected 800 lines per language; got zh={len(chinese_rows)} en={len(english_rows)}")
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
        "content_version": 1,
        "calendar_version": "2026-2040-v1",
        "calendar_year_start": 2026,
        "calendar_year_end": 2040,
        "languages": ["zh-CN", "en"],
        "items": items,
        "calendars": holidays,
    }
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
        lines.extend(["};", "inline constexpr std::size_t kCalendarCount = sizeof(kCalendars) / sizeof(kCalendars[0]);", "inline constexpr CatalogView kBuiltinCatalogView{kCatalogItems, kCatalogItemCount, kCalendars, kCalendarCount, 1};", "}  // namespace niuma::reminder", ""])
        args.header.parent.mkdir(parents=True, exist_ok=True)
        args.header.write_text("\n".join(lines), encoding="utf-8")
    if args.envelope_output:
        envelope = sign_catalog(payload, args.signing_key, args.key_id)
        args.envelope_output.parent.mkdir(parents=True, exist_ok=True)
        args.envelope_output.write_bytes(envelope)
    print(f"wrote {len(items)} lines and {len(holidays)} calendars to {args.output}")
    if args.envelope_output:
        print(f"signed official catalog version {catalog['content_version']} to {args.envelope_output}")


if __name__ == "__main__":
    try:
        main()
    except (KeyError, ValueError, OSError, zipfile.BadZipFile) as exc:
        print(f"catalog generation failed: {exc}", file=sys.stderr)
        sys.exit(1)
