"""Opens a workbook written by the app's XLSX writer (src/core/export/xlsx.ts) with openpyxl, a reader that has
nothing to do with our code, and checks every value, type and format. The workbook is the one in
src/core/export/xlsx-sample.ts: keep them together. Usage: python3 scripts/check-xlsx.py sample.xlsx"""

import datetime
import sys

from openpyxl import load_workbook

failures = []


def check(label, actual, expected):
    if actual != expected:
        failures.append(f"{label}: expected {expected!r}, got {actual!r}")


workbook = load_workbook(sys.argv[1])  # not read-only: styles, panes and widths are read too
check("sheet names", workbook.sheetnames, ["Invoices", "Text", "Q1_Q2_ totals_"])

# --- Invoices ---------------------------------------------------------------------------------------------
sheet = workbook["Invoices"]
check("header", [c.value for c in sheet[1]], ["id", "Amount", "paid", "Issued", "Sent", "note"])
check("header bold", all(c.font.bold for c in sheet[1]), True)
check("header frozen", sheet.freeze_panes, "A2")

check("A2 text", sheet["A2"].value, "INV-001")
check("B2 number", sheet["B2"].value, 1234.5)
check("B2 type", sheet["B2"].data_type, "n")
check("B2 format", sheet["B2"].number_format, "#,##0.00")
check("C2 boolean", sheet["C2"].value, True)
check("C2 type", sheet["C2"].data_type, "b")
check("D2 date", sheet["D2"].value, datetime.datetime(2026, 3, 5))
check("D2 format", sheet["D2"].number_format, "yyyy-mm-dd")
check("E2 date-time", sheet["E2"].value, datetime.datetime(2026, 3, 5, 14, 30))
check("E2 format", sheet["E2"].number_format, "yyyy-mm-dd hh:mm:ss")
check("F2 unicode", sheet["F2"].value, "Café – 日本語 😀")

check("A3 text that looks like a number", sheet["A3"].value, "007")
check("A3 type", sheet["A3"].data_type, "s")
check("B3 text converted to a number", sheet["B3"].value, 99.9)
check("C3 boolean false", sheet["C3"].value, False)
check("D3 ISO string converted to a date", sheet["D3"].value, datetime.datetime(2026, 12, 31))
check("E3 empty", sheet["E3"].value, None)
check("F3 empty", sheet["F3"].value, None)

check("B4 empty", sheet["B4"].value, None)
check("C4 empty", sheet["C4"].value, None)
check("D4 text that is not a date", sheet["D4"].value, "not a date")
check("E4 empty string", sheet["E4"].value, None)
check("F4 formula-looking text stays text", sheet["F4"].value, "=SUM(A1:A2)")
check("F4 type", sheet["F4"].data_type, "s")  # never a formula
check("max row", sheet.max_row, 4)

# --- Text -------------------------------------------------------------------------------------------------
sheet = workbook["Text"]
check("XML characters", sheet["B2"].value, "<tag attr=\"1\"> & 'quotes'")
check("line break", sheet["B3"].value, "first line\nsecond line")
check("long text cut to Excel's limit", sheet["B4"].value, "x" * 32767)

# --- the sheet whose name was repaired ----------------------------------------------------------------------
sheet = workbook["Q1_Q2_ totals_"]
check("numbers", [sheet.cell(row=r, column=1).value for r in (2, 3, 4)], [1, -2.5, 1e21])

if failures:
    print("\n".join(failures))
    sys.exit(1)
print("openpyxl read every cell of the workbook as expected")
