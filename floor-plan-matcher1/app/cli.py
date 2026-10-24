"""CLI: match floor-plan PDFs to a processor CSV without the website."""

from __future__ import annotations

import argparse
from pathlib import Path

from app.processor import process_job


def main() -> None:
    parser = argparse.ArgumentParser(description="Match named floor-plan PDFs to a processor CSV and stamp coordinates.")
    parser.add_argument("--named", required=True, help="PDF with area names")
    parser.add_argument("--unnamed", required=True, help="PDF without area names")
    parser.add_argument("--csv", required=True, help="Processor CSV")
    parser.add_argument("--clean", default=None, help="Optional clean/LMS layout PDF for leaf_coordinates.csv")
    parser.add_argument("--out", default="data/cli-output", help="Output folder")
    parser.add_argument("--name-column", default=None, help="CSV column that contains area names")
    parser.add_argument("--all-shapes", action="store_true", help="Use all closed shapes if green outlines are not detected")
    args = parser.parse_args()

    csv_bytes = Path(args.csv).read_bytes()
    result = process_job(
        named_pdf=Path(args.named),
        unnamed_pdf=Path(args.unnamed),
        csv_bytes=csv_bytes,
        output_dir=Path(args.out),
        name_column=args.name_column,
        green_only=not args.all_shapes,
        clean_pdf=Path(args.clean) if args.clean else None,
    )
    summary = result["summary"]
    print(
        "Done. "
        f"labels={summary['labels_found']} polygons={summary['polygons_found']} "
        f"matched={summary['matched']} unmatched={summary['unmatched']}"
    )
    print(f"Output: {Path(args.out).resolve()}")


if __name__ == "__main__":
    main()
