"""Generate demo floor-plan PDFs and a processor CSV."""

from __future__ import annotations

from pathlib import Path

import pymupdf as fitz
import pandas as pd

AREAS = [
    ("WS-OS-01", 40, 40, 110, 95),
    ("WS-OS-02", 120, 40, 190, 95),
    ("WS-OS-03", 200, 40, 270, 95),
    ("WS-OS-04", 280, 40, 350, 95),
    ("WS-OS-05", 360, 40, 430, 95),
    ("MEETING ROOM OS-02", 40, 120, 220, 230),
    ("COLLAB OS-27", 240, 120, 360, 200),
    ("ELECTRICAL ROOM 1", 380, 120, 500, 190),
    ("PASSAGE OS-17", 40, 250, 500, 300),
    ("PANTRY OS-08", 40, 320, 180, 400),
]


def generate_sample_files(dest: Path) -> dict[str, str]:
    dest.mkdir(parents=True, exist_ok=True)
    named = dest / "with_name.pdf"
    unnamed = dest / "without_name.pdf"
    csv_path = dest / "processor.csv"

    _write_plan(named, with_names=True)
    _write_plan(unnamed, with_names=False)

    rows = [{"area_name": name, "floor": "1st Floor", "type": "space"} for name, *_ in AREAS]
    rows.append({"area_name": "STORE OS-99", "floor": "1st Floor", "type": "space"})
    pd.DataFrame(rows).to_csv(csv_path, index=False)

    return {
        "with_name": str(named),
        "without_name": str(unnamed),
        "csv": str(csv_path),
    }


def _write_plan(path: Path, with_names: bool) -> None:
    doc = fitz.open()
    page = doc.new_page(width=560, height=440)
    page.draw_rect(page.rect, color=(0.82, 0.86, 0.82), fill=(0.96, 0.97, 0.95), width=0)
    page.draw_rect(fitz.Rect(20, 20, 540, 420), color=(0.1, 0.1, 0.1), width=1.2)

    page.insert_text((28, 34), "1ST FLOOR — SAMPLE PLAN", fontsize=11, fontname="helv", color=(0.12, 0.2, 0.16))
    subtitle = "WITH NAME" if with_names else "WITHOUT NAME"
    page.insert_text((430, 34), subtitle, fontsize=8, fontname="helv", color=(0.2, 0.45, 0.28))

    green = (0.45, 0.82, 0.42)
    for name, x0, y0, x1, y1 in AREAS:
        rect = fitz.Rect(x0, y0, x1, y1)
        page.draw_rect(rect, color=green, fill=None, width=1.3)
        if "WS-OS" in name:
            seat = fitz.Rect(x0 + 8, y0 + 14, x0 + 28, y0 + 40)
            page.draw_rect(seat, color=(0.55, 0.55, 0.55), width=0.4)
        if with_names:
            page.insert_textbox(
                rect + (0, 6, 0, -4),
                name,
                fontname="helv",
                fontsize=7,
                color=(0.08, 0.28, 0.14),
                align=fitz.TEXT_ALIGN_CENTER,
            )

    doc.save(path, deflate=True)
    doc.close()
