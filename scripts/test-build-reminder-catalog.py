#!/usr/bin/env python3
"""Publisher regressions; all workbook/output fixtures stay in isolated temp roots."""

import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("reminder_builder", ROOT / "scripts/build-reminder-catalog.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class PublisherTests(unittest.TestCase):
    def setUp(self):
        acceptance = ROOT / ".local-work/acceptance"
        acceptance.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="reminder-publisher-", dir=acceptance)
        self.directory = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def workbook(self, reverse=False, formula_source=False):
        labels = ["稳定ID", "分类", "语气", "文案原稿", "审核状态", "修改稿", "最终正文（自动）",
                  "活动触发", "加班条件", "节日编码", "开始时刻", "结束时刻", "节前天数", "节后天数"]
        values = ["nm.zh.0001", "普通", "幽默", "原始文案正文", "删除", "修改后的正文", "过期的缓存正文",
                  "两者均可", "不限", "", "00:00", "24:00", "0", "0"]
        pairs = list(zip(labels, values))
        if reverse:
            pairs.reverse()
        ns = builder.NS["m"]
        sheet = ET.Element(f"{{{ns}}}worksheet")
        data = ET.SubElement(sheet, f"{{{ns}}}sheetData")
        for row_number in (1, 2):
            row = ET.SubElement(data, f"{{{ns}}}row", r=str(row_number))
            for index, (label, value) in enumerate(pairs):
                cell = ET.SubElement(row, f"{{{ns}}}c", r=f"{chr(65 + index)}{row_number}", t="str")
                if row_number == 2 and (label == "最终正文（自动）" or (formula_source and label == "文案原稿")):
                    ET.SubElement(cell, f"{{{ns}}}f").text = '"cached formula"'
                ET.SubElement(cell, f"{{{ns}}}v").text = label if row_number == 1 else value
        path = self.directory / "fixture.xlsx"
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("xl/workbook.xml", f'<workbook xmlns="{ns}" xmlns:r="{builder.NS["r"]}"><sheets><sheet name="文案总表" sheetId="1" r:id="rId1"/></sheets></workbook>')
            archive.writestr("xl/_rels/workbook.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')
            archive.writestr("xl/worksheets/sheet1.xml", ET.tostring(sheet, encoding="utf-8"))
        return builder.workbook_sheets(path)["文案总表"]

    @staticmethod
    def catalog(version=2):
        return {"schema_version": 2, "catalog_id": "official.multilingual", "content_version": version,
                "calendar_version": "2026-2040-v1", "items": [
                    {"id": "nm.zh.0001", "language": "zh-CN", "text": "中文文案正文"},
                    {"id": "nm.en.0001", "language": "en", "text": "An ordinary work joke."}]}

    def test_named_columns_ignore_stale_final_formula_and_review_filter(self):
        for reverse in (False, True):
            rows = builder.named_item_rows(self.workbook(reverse=reverse), "zh-CN")
            self.assertEqual(len(rows), 1)
            item = builder.make_item(rows[0], "zh-CN")
            self.assertEqual(item["text"], "修改后的正文")
            self.assertEqual(item["id"], "nm.zh.0001")
        # The owner's explicit instruction includes current rows even if the
        # workbook review cell says delete; the cached final cell is never used.

    def test_formula_source_text_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "formula source text"):
            builder.named_item_rows(self.workbook(formula_source=True), "zh-CN")

    def test_missing_or_ambiguous_headers_fail(self):
        rows = self.workbook()
        rows[0]["Z"] = "稳定ID"
        with self.assertRaises(ValueError):
            builder.named_item_rows(rows, "zh-CN")
        rows = self.workbook()
        column = next(key for key, value in rows[0].items() if value == "修改稿")
        del rows[0][column]
        with self.assertRaises(ValueError):
            builder.named_item_rows(rows, "zh-CN")

    def test_update_requires_lower_previous_version(self):
        current = self.catalog()
        with self.assertRaises(ValueError):
            builder.validate_publication(current)
        self.assertEqual(builder.validate_publication(current, self.catalog(1))["copy_edited_ids"], [])
        for previous in (self.catalog(2), self.catalog(3)):
            with self.assertRaises(ValueError):
                builder.validate_publication(current, previous)
        for version in (0, True, 2**32):
            current["content_version"] = version
            with self.assertRaises(ValueError):
                builder.validate_publication(current, self.catalog(1))

    def test_copy_edit_requires_exact_acknowledgment(self):
        previous = self.catalog(1)
        current = self.catalog(2)
        current["items"][0]["text"] += "。"
        with self.assertRaises(ValueError):
            builder.validate_publication(current, previous)
        self.assertEqual(builder.validate_publication(current, previous, ["nm.zh.0001"])["copy_edited_ids"], ["nm.zh.0001"])
        with self.assertRaises(ValueError):
            builder.validate_publication(current, previous, ["nm.zh.0001", "nm.en.typo"])

    def test_new_and_retired_ids_allow_complete_update_size_changes(self):
        previous = self.catalog(1)
        current = self.catalog(2)
        current["items"][1]["id"] = "nm.en.0002"
        current["items"].append({"id": "nm.en.0003", "language": "en", "text": "A new complete-library entry."})
        self.assertEqual(builder.validate_publication(current, previous)["retired_ids"], ["nm.en.0001"])

    def test_initial_catalog_keeps_all_approved_rows(self):
        initial = self.catalog(1)
        with self.assertRaises(ValueError):
            builder.validate_publication(initial)
        initial["items"] = [{"id": f"nm.{code}.{index:04}", "language": language, "text": "Approved text."}
                            for code, language in (("zh", "zh-CN"), ("en", "en")) for index in range(1, 801)]
        builder.validate_publication(initial)
        initial["items"].pop()
        with self.assertRaises(ValueError):
            builder.validate_publication(initial)

    def test_duplicate_ids_and_missing_language_fail(self):
        previous = self.catalog(1)
        for mutation in (lambda c: c["items"].append(copy.deepcopy(c["items"][0])),
                         lambda c: c["items"].pop()):
            current = self.catalog()
            mutation(current)
            with self.assertRaises(ValueError):
                builder.validate_publication(current, previous)

    def test_previous_json_duplicate_keys_fail(self):
        path = self.directory / "previous.json"
        path.write_text('{"content_version":1,"content_version":2}')
        with self.assertRaisesRegex(ValueError, "duplicate JSON key"):
            builder.read_previous_catalog(path)

    def test_signature_der_canonical_form(self):
        self.assertEqual(builder.raw_ecdsa_signature(bytes.fromhex("3006020101020102")),
                         bytes(31) + b"\x01" + bytes(31) + b"\x02")
        for encoded in ("3006020180020102", "3006020100020102", "300702020001020102", "300602010102010200"):
            with self.assertRaises(ValueError):
                builder.raw_ecdsa_signature(bytes.fromhex(encoded))


if __name__ == "__main__":
    unittest.main(verbosity=2)
