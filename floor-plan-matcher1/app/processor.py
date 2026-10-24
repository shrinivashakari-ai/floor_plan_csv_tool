"""Extract labeled areas from floor-plan PDFs and match them to a processor CSV."""

from __future__ import annotations

import csv
import io
import json
import re
import zipfile
from collections import defaultdict
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Iterable

import pymupdf as fitz
import pandas as pd
from rapidfuzz import fuzz, process as rf_process
from shapely.geometry import Point, Polygon, box
from shapely.validation import make_valid

from app.clean_polygon import clean_leaf_ring

FUZZY_THRESHOLD = 90
NEAR_POLYGON_PT = 28.0
MIN_POLYGON_AREA = 40.0
MAX_POLYGON_PAGE_RATIO = 0.85
PREVIEW_MAX_SIDE = 2200
STAMP_FONT_SIZE = 8.0
CODE_COLUMN_ALIASES = {"code", "area_code", "leaf_code", "space_code", "room_code"}

NAME_COLUMN_CANDIDATES = [
    "name",
    "area",
    "area_name",
    "area name",
    "spacename",
    "space_name",
    "space name",
    "space",
    "label",
    "room",
    "room_name",
    "room name",
    "workstation",
    "ws",
    "code",
    "id",
    "location",
]


@dataclass
class Label:
    text: str
    normalized: str
    page: int
    x0: float
    y0: float
    x1: float
    y1: float

    @property
    def center(self) -> tuple[float, float]:
        return ((self.x0 + self.x1) / 2.0, (self.y0 + self.y1) / 2.0)


@dataclass
class AreaPolygon:
    page: int
    points: list[tuple[float, float]]
    geom: Any
    color: str = "green"

    @property
    def bounds(self) -> tuple[float, float, float, float]:
        minx, miny, maxx, maxy = self.geom.bounds
        return (minx, miny, maxx, maxy)

    @property
    def centroid(self) -> tuple[float, float]:
        c = self.geom.centroid
        return (c.x, c.y)


@dataclass
class MatchRow:
    csv_name: str
    pdf_name: str = ""
    status: str = "unmatched"
    score: float = 0.0
    page: int | None = None
    x0: float | None = None
    y0: float | None = None
    x1: float | None = None
    y1: float | None = None
    center_x: float | None = None
    center_y: float | None = None
    polygon: str = ""
    extra: dict[str, Any] = field(default_factory=dict)


def normalize_name(value: Any) -> str:
    text = str(value or "").upper().strip()
    text = text.replace("_", " ").replace("-", " ")
    text = re.sub(r"[^A-Z0-9 ]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def detect_name_column(columns: Iterable[str]) -> str | None:
    normalized = {str(col).strip().lower(): str(col) for col in columns}
    for candidate in NAME_COLUMN_CANDIDATES:
        if candidate in normalized:
            return normalized[candidate]
    for key, original in normalized.items():
        if "name" in key or key in {"area", "space", "label", "code"}:
            return original
    cols = list(columns)
    return cols[0] if cols else None


def row_code(row: MatchRow) -> str:
    extra = row.extra or {}
    for key, value in extra.items():
        if str(key).strip().lower() in CODE_COLUMN_ALIASES:
            text = str(value).strip()
            if text and text.lower() not in {"nan", "none", "null"}:
                return text
    return ""


def _wrap_stamp_text(text: str, max_chars: int = 26) -> list[str]:
    text = " ".join(str(text or "").replace("_", " ").split())
    if not text:
        return []
    if len(text) <= max_chars:
        return [text]
    words = text.split()
    lines: list[str] = []
    current = ""
    for word in words:
        chunks = [word[i : i + max_chars] for i in range(0, len(word), max_chars)] or [word]
        for chunk in chunks:
            trial = f"{current} {chunk}".strip()
            if len(trial) <= max_chars:
                current = trial
            else:
                if current:
                    lines.append(current)
                current = chunk
    if current:
        lines.append(current)
    return lines


def _rgb(color: Any) -> tuple[float, float, float] | None:
    if not color or not isinstance(color, (list, tuple)) or len(color) < 3:
        return None
    r, g, b = float(color[0]), float(color[1]), float(color[2])
    if max(r, g, b) > 1.5:
        r, g, b = r / 255.0, g / 255.0, b / 255.0
    return (r, g, b)


def is_greenish(color: Any) -> bool:
    rgb = _rgb(color)
    if rgb is None:
        return False
    r, g, b = rgb
    if g < 0.28:
        return False
    if r > 0.88 and g > 0.88 and b > 0.88:
        return False
    if r < 0.12 and g < 0.12 and b < 0.12:
        return False
    return g >= r + 0.04 and g >= b + 0.04


def _bezier(
    p1: fitz.Point,
    p2: fitz.Point,
    p3: fitz.Point,
    p4: fitz.Point,
    t: float,
) -> tuple[float, float]:
    u = 1.0 - t
    x = (u**3) * p1.x + 3 * (u**2) * t * p2.x + 3 * u * (t**2) * p3.x + (t**3) * p4.x
    y = (u**3) * p1.y + 3 * (u**2) * t * p2.y + 3 * u * (t**2) * p3.y + (t**3) * p4.y
    return (x, y)


def drawing_to_points(drawing: dict[str, Any]) -> list[tuple[float, float]]:
    points: list[tuple[float, float]] = []
    for item in drawing.get("items") or []:
        kind = item[0]
        if kind == "re":
            rect = item[1]
            return [
                (rect.x0, rect.y0),
                (rect.x1, rect.y0),
                (rect.x1, rect.y1),
                (rect.x0, rect.y1),
            ]
        if kind == "qu":
            quad = item[1]
            return [
                (quad.ul.x, quad.ul.y),
                (quad.ur.x, quad.ur.y),
                (quad.lr.x, quad.lr.y),
                (quad.ll.x, quad.ll.y),
            ]
        if kind == "l":
            p1, p2 = item[1], item[2]
            if not points:
                points.append((p1.x, p1.y))
            points.append((p2.x, p2.y))
        elif kind == "c":
            p1, p2, p3, p4 = item[1], item[2], item[3], item[4]
            if not points:
                points.append((p1.x, p1.y))
            for t in (0.25, 0.5, 0.75, 1.0):
                points.append(_bezier(p1, p2, p3, p4, t))
    return _dedupe_points(points)


def _dedupe_points(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    cleaned: list[tuple[float, float]] = []
    for pt in points:
        if not cleaned or (abs(cleaned[-1][0] - pt[0]) > 0.2 or abs(cleaned[-1][1] - pt[1]) > 0.2):
            cleaned.append(pt)
    if len(cleaned) >= 4 and abs(cleaned[0][0] - cleaned[-1][0]) < 0.4 and abs(cleaned[0][1] - cleaned[-1][1]) < 0.4:
        cleaned = cleaned[:-1]
    return cleaned


def _polygon_from_points(points: list[tuple[float, float]], page_rect: fitz.Rect) -> Polygon | None:
    if len(points) == 2:
        (x0, y0), (x1, y1) = points
        if abs(x0 - x1) < 1 or abs(y0 - y1) < 1:
            return None
        geom = box(min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))
    elif len(points) >= 3:
        geom = Polygon(points)
        if not geom.is_valid:
            geom = make_valid(geom)
        if geom.geom_type == "MultiPolygon":
            geom = max(geom.geoms, key=lambda g: g.area)
        if geom.geom_type != "Polygon" or geom.is_empty:
            return None
    else:
        return None

    page_area = float(page_rect.width * page_rect.height) or 1.0
    if geom.area < MIN_POLYGON_AREA:
        return None
    if geom.area / page_area > MAX_POLYGON_PAGE_RATIO:
        return None
    return geom


def extract_labels(doc: fitz.Document) -> list[Label]:
    labels: list[Label] = []
    skip_numeric = re.compile(r"^\d+([.,]\d+)?$")
    skip_dimension = re.compile(r"^\d+\s*[xX×]\s*\d+$")
    for page_index, page in enumerate(doc, start=1):
        data = page.get_text("dict")
        for block in data.get("blocks", []):
            for line in block.get("lines", []):
                spans = line.get("spans", [])
                if not spans:
                    continue
                text = "".join(span.get("text", "") for span in spans).strip()
                if not text or len(text) < 2:
                    continue
                if skip_numeric.match(text) or skip_dimension.match(text):
                    continue
                xs0, ys0, xs1, ys1 = [], [], [], []
                for span in spans:
                    bbox = span.get("bbox") or [0, 0, 0, 0]
                    xs0.append(bbox[0])
                    ys0.append(bbox[1])
                    xs1.append(bbox[2])
                    ys1.append(bbox[3])
                labels.append(
                    Label(
                        text=text,
                        normalized=normalize_name(text),
                        page=page_index,
                        x0=min(xs0),
                        y0=min(ys0),
                        x1=max(xs1),
                        y1=max(ys1),
                    )
                )
    unique: dict[tuple[str, int, float, float], Label] = {}
    for label in labels:
        if not label.normalized:
            continue
        key = (label.normalized, label.page, round(label.x0, 1), round(label.y0, 1))
        unique[key] = label
    return list(unique.values())


def extract_polygons(doc: fitz.Document, green_only: bool = True) -> tuple[list[AreaPolygon], str]:
    polygons: list[AreaPolygon] = []
    mode = "green"

    def collect(require_green: bool) -> list[AreaPolygon]:
        found: list[AreaPolygon] = []
        for page_index, page in enumerate(doc, start=1):
            for drawing in page.get_drawings():
                stroke = drawing.get("color")
                fill = drawing.get("fill")
                if require_green and not (is_greenish(stroke) or is_greenish(fill)):
                    continue
                points = drawing_to_points(drawing)
                if len(points) < 2:
                    rect = drawing.get("rect")
                    if rect:
                        points = [
                            (rect.x0, rect.y0),
                            (rect.x1, rect.y0),
                            (rect.x1, rect.y1),
                            (rect.x0, rect.y1),
                        ]
                geom = _polygon_from_points(points, page.rect)
                if geom is None:
                    continue
                found.append(
                    AreaPolygon(
                        page=page_index,
                        points=list(geom.exterior.coords)[:-1],
                        geom=geom,
                        color="green" if require_green else "fallback",
                    )
                )
        return _unique_polygons(found)

    polygons = collect(require_green=True)
    if not polygons and green_only:
        polygons = collect(require_green=False)
        mode = "fallback_all_closed_shapes"
    elif not green_only and not polygons:
        polygons = collect(require_green=False)
        mode = "fallback_all_closed_shapes"
    return polygons, mode


def _unique_polygons(polygons: list[AreaPolygon]) -> list[AreaPolygon]:
    unique: list[AreaPolygon] = []
    for poly in polygons:
        duplicate = False
        for existing in unique:
            if existing.page != poly.page:
                continue
            if existing.geom.equals_exact(poly.geom, 1.0) or (
                existing.geom.intersection(poly.geom).area / max(existing.geom.area, 1e-6) > 0.96
                and abs(existing.geom.area - poly.geom.area) / max(existing.geom.area, 1e-6) < 0.08
            ):
                duplicate = True
                break
        if not duplicate:
            unique.append(poly)
    return unique


def assign_label_polygon(label: Label, polygons: list[AreaPolygon]) -> AreaPolygon | None:
    point = Point(*label.center)
    containing = [p for p in polygons if p.page == label.page and p.geom.contains(point)]
    if containing:
        return min(containing, key=lambda p: p.geom.area)

    nearby: list[tuple[float, AreaPolygon]] = []
    for poly in polygons:
        if poly.page != label.page:
            continue
        dist = poly.geom.distance(point)
        if dist <= NEAR_POLYGON_PT:
            nearby.append((dist, poly))
    if nearby:
        nearby.sort(key=lambda item: (item[0], item[1].geom.area))
        return nearby[0][1]
    return None


def _instance_order(item: tuple[Label, AreaPolygon]) -> tuple[int, float, float]:
    label, _poly = item
    cx, cy = label.center
    return (label.page, round(cx, 1), round(cy, 1))


def build_label_map(
    labels: list[Label], polygons: list[AreaPolygon]
) -> dict[str, list[tuple[Label, AreaPolygon]]]:
    mapped: dict[str, list[tuple[Label, AreaPolygon]]] = {}
    for label in labels:
        poly = assign_label_polygon(label, polygons)
        if poly is None:
            continue
        instances = mapped.setdefault(label.normalized, [])
        if any(_polygons_same(poly.geom, existing.geom) for _existing_label, existing in instances):
            continue
        instances.append((label, poly))
    for instances in mapped.values():
        instances.sort(key=_instance_order)
    return mapped


def _polygons_same(a: Any, b: Any) -> bool:
    if a is None or b is None or getattr(a, "is_empty", True) or getattr(b, "is_empty", True):
        return False
    try:
        if a.equals_exact(b, 1.0):
            return True
        denom = max(float(a.area), 1e-6)
        overlap = float(a.intersection(b).area) / denom
        area_diff = abs(float(a.area) - float(b.area)) / denom
        return overlap > 0.96 and area_diff < 0.08
    except Exception:  # noqa: BLE001
        return False


def _geom_from_row(row: MatchRow) -> Any | None:
    points = polygon_points(row)
    if len(points) >= 3:
        geom = Polygon(points)
        if not geom.is_valid:
            geom = make_valid(geom)
        if geom.geom_type == "MultiPolygon":
            geom = max(geom.geoms, key=lambda item: item.area)
        if geom.geom_type == "Polygon" and not geom.is_empty:
            return geom
    if None in (row.x0, row.y0, row.x1, row.y1):
        return None
    return box(float(row.x0), float(row.y0), float(row.x1), float(row.y1))


def _best_pdf_only_name(labels: list[Label]) -> str:
    def score(label: Label) -> tuple[int, int, int, str]:
        text = (label.text or "").strip()
        compact = re.sub(r"[^A-Z0-9]", "", text.upper())
        letters = sum(ch.isalpha() for ch in compact)
        short_code = bool(re.fullmatch(r"[A-Z]{1,5}\d{0,3}", compact) and letters <= 5)
        return (0 if short_code else 1, letters, len(text), text.upper())

    return max(labels, key=score).text


def pdf_only_rows(
    label_map: dict[str, list[tuple[Label, AreaPolygon]]],
    matched_rows: list[MatchRow],
) -> list[MatchRow]:
    used_geoms: list[Any] = []
    for row in matched_rows:
        if row.status not in {"matched", "fuzzy"}:
            continue
        geom = _geom_from_row(row)
        if geom is not None:
            used_geoms.append(geom)

    groups: list[tuple[AreaPolygon, list[Label]]] = []
    for _key, instances in label_map.items():
        for label, poly in instances:
            if any(_polygons_same(poly.geom, geom) for geom in used_geoms):
                continue
            attached = False
            for group_poly, names in groups:
                if _polygons_same(poly.geom, group_poly.geom):
                    names.append(label)
                    attached = True
                    break
            if not attached:
                groups.append((poly, [label]))

    leftover: list[MatchRow] = []
    for poly, labels in groups:
        x0, y0, x1, y1 = poly.bounds
        cx, cy = poly.centroid
        leftover.append(
            MatchRow(
                csv_name="",
                pdf_name=_best_pdf_only_name(labels),
                status="pdf_only",
                score=0.0,
                page=poly.page,
                x0=round(x0, 2),
                y0=round(y0, 2),
                x1=round(x1, 2),
                y1=round(y1, 2),
                center_x=round(cx, 2),
                center_y=round(cy, 2),
                polygon=json.dumps([[round(x, 2), round(y, 2)] for x, y in poly.points]),
            )
        )
    leftover.sort(key=lambda row: (row.page or 0, (row.pdf_name or "").upper()))
    return leftover


def read_processor_csv(content: bytes, name_column: str | None = None) -> tuple[pd.DataFrame, str]:
    last_error: Exception | None = None
    frame: pd.DataFrame | None = None
    for encoding in ("utf-8-sig", "utf-8", "latin-1"):
        try:
            frame = pd.read_csv(io.BytesIO(content), encoding=encoding, dtype=str, keep_default_na=False)
            break
        except Exception as exc:  # noqa: BLE001
            last_error = exc
    if frame is None:
        raise ValueError(f"Could not read CSV: {last_error}")

    frame.columns = [str(col).strip() for col in frame.columns]
    column = name_column if name_column and name_column in frame.columns else detect_name_column(frame.columns)
    if not column:
        raise ValueError("CSV has no usable name column.")
    frame = frame.copy()
    frame["_normalized"] = frame[column].map(normalize_name)
    frame = frame[frame["_normalized"] != ""].reset_index(drop=True)
    return frame, column


def match_csv_to_labels(
    frame: pd.DataFrame,
    name_column: str,
    label_map: dict[str, list[tuple[Label, AreaPolygon]]],
    extra_columns: list[str] | None = None,
) -> list[MatchRow]:
    remaining = {key: list(instances) for key, instances in label_map.items()}
    rows: list[MatchRow] = []

    def available_names() -> list[str]:
        return [name for name, instances in remaining.items() if instances]

    for _, csv_row in frame.iterrows():
        csv_name = str(csv_row[name_column]).strip()
        normalized = csv_row["_normalized"]
        extra = {}
        for col in extra_columns or [c for c in frame.columns if not c.startswith("_") and c != name_column]:
            extra[col] = csv_row[col]

        row = MatchRow(csv_name=csv_name, extra=extra)
        pdf_key = None
        score = 0.0

        if remaining.get(normalized):
            pdf_key = normalized
            score = 100.0
        else:
            candidates = available_names()
            if candidates:
                result = rf_process.extractOne(
                    normalized,
                    candidates,
                    scorer=fuzz.token_sort_ratio,
                )
                if result and result[1] >= FUZZY_THRESHOLD:
                    pdf_key = result[0]
                    score = float(result[1])

        if not pdf_key or not remaining.get(pdf_key):
            rows.append(row)
            continue

        label, poly = remaining[pdf_key].pop(0)
        x0, y0, x1, y1 = poly.bounds
        cx, cy = poly.centroid
        row.pdf_name = label.text
        row.status = "matched" if score >= 99.5 else "fuzzy"
        row.score = round(score, 1)
        row.page = poly.page
        row.x0 = round(x0, 2)
        row.y0 = round(y0, 2)
        row.x1 = round(x1, 2)
        row.y1 = round(y1, 2)
        row.center_x = round(cx, 2)
        row.center_y = round(cy, 2)
        row.polygon = json.dumps([[round(x, 2), round(y, 2)] for x, y in poly.points])
        rows.append(row)

    return rows


def page_size(pdf_path: Path, page_index: int = 0) -> dict[str, float]:
    doc = fitz.open(pdf_path)
    try:
        page = doc[page_index]
        return {"width": float(page.rect.width), "height": float(page.rect.height)}
    finally:
        doc.close()


def polygon_bounds(polygons: list[AreaPolygon], page: int = 1) -> tuple[float, float, float, float] | None:
    xs: list[float] = []
    ys: list[float] = []
    for poly in polygons:
        if poly.page != page:
            continue
        for x, y in poly.points:
            xs.append(x)
            ys.append(y)
    if not xs:
        return None
    return (min(xs), min(ys), max(xs), max(ys))


def compute_fit_transform(
    named_polygons: list[AreaPolygon],
    unnamed_polygons: list[AreaPolygon],
    named_page: dict[str, float],
    unnamed_page: dict[str, float],
) -> dict[str, float]:
    named_box = polygon_bounds(named_polygons)
    unnamed_box = polygon_bounds(unnamed_polygons)
    if named_box is None or unnamed_box is None:
        named_box = (0.0, 0.0, named_page["width"], named_page["height"])
        unnamed_box = (0.0, 0.0, unnamed_page["width"], unnamed_page["height"])
    nw = max(named_box[2] - named_box[0], 1.0)
    nh = max(named_box[3] - named_box[1], 1.0)
    uw = max(unnamed_box[2] - unnamed_box[0], 1.0)
    uh = max(unnamed_box[3] - unnamed_box[1], 1.0)
    scale = min(4.0, max(0.25, ((uw / nw) + (uh / nh)) / 2.0))
    ncx = (named_box[0] + named_box[2]) / 2.0
    ncy = (named_box[1] + named_box[3]) / 2.0
    ucx = (unnamed_box[0] + unnamed_box[2]) / 2.0
    ucy = (unnamed_box[1] + unnamed_box[3]) / 2.0
    return {
        "scale": round(scale, 6),
        "tx": round(ucx - ncx * scale, 4),
        "ty": round(ucy - ncy * scale, 4),
    }


def transform_point(x: float, y: float, scale: float, tx: float, ty: float) -> tuple[float, float]:
    return (x * scale + tx, y * scale + ty)


def transform_rows(rows: list[MatchRow], scale: float, tx: float, ty: float) -> list[MatchRow]:
    transformed: list[MatchRow] = []
    for row in rows:
        if row.status not in {"matched", "fuzzy", "pdf_only"} or row.x0 is None or row.y0 is None or row.x1 is None or row.y1 is None:
            transformed.append(row)
            continue
        x0, y0 = transform_point(row.x0, row.y0, scale, tx, ty)
        x1, y1 = transform_point(row.x1, row.y1, scale, tx, ty)
        cx, cy = transform_point(row.center_x or 0.0, row.center_y or 0.0, scale, tx, ty)
        points = json.loads(row.polygon) if row.polygon else []
        tpoints = [transform_point(float(x), float(y), scale, tx, ty) for x, y in points]
        transformed.append(
            MatchRow(
                csv_name=row.csv_name,
                pdf_name=row.pdf_name,
                status=row.status,
                score=row.score,
                page=row.page,
                x0=round(min(x0, x1), 2),
                y0=round(min(y0, y1), 2),
                x1=round(max(x0, x1), 2),
                y1=round(max(y0, y1), 2),
                center_x=round(cx, 2),
                center_y=round(cy, 2),
                polygon=json.dumps([[round(x, 2), round(y, 2)] for x, y in tpoints]),
                extra=row.extra,
            )
        )
    return transformed


def public_rows(rows: list[MatchRow]) -> list[dict[str, Any]]:
    return [
        {
            "csv_name": r.csv_name,
            "code": row_code(r),
            "pdf_name": r.pdf_name,
            "status": r.status,
            "score": r.score,
            "page": r.page,
            "x0": r.x0,
            "y0": r.y0,
            "x1": r.x1,
            "y1": r.y1,
            "center_x": r.center_x,
            "center_y": r.center_y,
            "polygon": json.loads(r.polygon) if r.polygon else [],
        }
        for r in rows
    ]


def rows_from_stored(items: list[dict[str, Any]]) -> list[MatchRow]:
    rows: list[MatchRow] = []
    for item in items:
        polygon = item.get("polygon") or []
        if isinstance(polygon, str):
            polygon_text = polygon
        else:
            polygon_text = json.dumps(polygon)
        extra = dict(item.get("extra") or {})
        if "code" in item and "code" not in extra:
            extra["code"] = item.get("code")
        rows.append(
            MatchRow(
                csv_name=item.get("csv_name", ""),
                pdf_name=item.get("pdf_name", ""),
                status=item.get("status", "unmatched"),
                score=float(item.get("score") or 0),
                page=item.get("page"),
                x0=item.get("x0"),
                y0=item.get("y0"),
                x1=item.get("x1"),
                y1=item.get("y1"),
                center_x=item.get("center_x"),
                center_y=item.get("center_y"),
                polygon=polygon_text,
                extra=extra,
            )
        )
    return rows


def page_metrics(page: fitz.Page) -> dict[str, float]:
    rect = page.rect
    return {
        "x0": round(float(rect.x0), 4),
        "y0": round(float(rect.y0), 4),
        "width": float(rect.width),
        "height": float(rect.height),
    }


def extra_value(row: MatchRow, *keys: str) -> str:
    extra = row.extra or {}
    lowered = {str(key).strip().lower().replace("-", " ").replace("_", " "): value for key, value in extra.items()}
    for key in keys:
        lookup = str(key).strip().lower().replace("-", " ").replace("_", " ")
        value = lowered.get(lookup)
        if value is None:
            continue
        text = str(value).strip()
        if text and text.lower() not in {"nan", "none", "null"}:
            return text
    return ""


def overlay_extra_fields(row: MatchRow) -> dict[str, str]:
    return {
        "processor_id": extra_value(row, "processor_id", "processor id"),
        "root_area": extra_value(row, "root_area", "root area"),
        "root_subarea": extra_value(row, "root_subarea", "root subarea"),
        "root_sub_subarea": extra_value(row, "root_sub_subarea", "root sub subarea", "root sub-subarea"),
    }


def polygon_points(row: MatchRow) -> list[tuple[float, float]]:
    raw = row.polygon
    if not raw:
        return []
    try:
        points = json.loads(raw) if isinstance(raw, str) else raw
    except json.JSONDecodeError:
        return []
    parsed: list[tuple[float, float]] = []
    for point in points:
        if isinstance(point, (list, tuple)) and len(point) >= 2:
            parsed.append((float(point[0]), float(point[1])))
    return parsed


def format_xy(x: float, y: float) -> str:
    def fmt(value: float) -> str:
        rounded = round(value)
        if abs(value - rounded) < 0.005:
            return str(int(rounded))
        return f"{value:.2f}"
    return f"{fmt(x)}~{fmt(y)}"


_OS_RANGE = re.compile(r"(?i)^(.*?)\bOS[\s\-]*(\d+)\s*[-–]\s*(\d+)\s*$")
_OS_NUM = re.compile(r"(?i)\bOS[\s\-]*(\d+)\b")


def _decode_bacnet_text(content: bytes) -> str:
    if content.startswith(b"\xff\xfe") or content.startswith(b"\xfe\xff"):
        return content.decode("utf-16")
    for encoding in ("utf-8-sig", "utf-8", "utf-16", "latin-1"):
        try:
            return content.decode(encoding)
        except UnicodeDecodeError:
            continue
    return content.decode("latin-1", errors="replace")


def _bacnet_table_rows(text: str) -> list[list[str]]:
    best: list[list[str]] = []
    best_score = -1
    for delimiter in (",", "\t", ";", "|"):
        rows = [[cell.strip() for cell in row] for row in csv.reader(io.StringIO(text), delimiter=delimiter)]
        score = 0
        for row in rows:
            lowered = [cell.lower() for cell in row]
            if "device name" in lowered or "device_name" in lowered:
                score += 5
            if any("network number" in cell or cell == "network" for cell in lowered):
                score += 5
            score += max(0, len(row) - 1)
        if score > best_score:
            best_score = score
            best = rows
    return best


def parse_bacnet_report(content: bytes) -> list[dict[str, str]]:
    if content[:2] == b"PK":
        raise ValueError("Upload the BACnet ID report as CSV (in Excel: File → Save As → CSV).")
    rows = _bacnet_table_rows(_decode_bacnet_text(content))
    header_idx = None
    name_col = None
    net_col = None
    for idx, row in enumerate(rows):
        lowered = [re.sub(r"\s+", " ", cell).lower() for cell in row]
        for col, cell in enumerate(lowered):
            if cell in {"device name", "device_name", "devicename"}:
                header_idx = idx
                name_col = col
                break
        if header_idx is None:
            continue
        for col, cell in enumerate(lowered):
            if cell in {"network number", "network"} or ("network" in cell and "number" in cell):
                net_col = col
                break
        break
    if header_idx is None or name_col is None:
        raise ValueError("Could not find a 'Device name' column in the BACnet ID report.")
    if net_col is None:
        raise ValueError("Could not find a 'Network Number' column in the BACnet ID report.")

    devices: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for row in rows[header_idx + 1 :]:
        if name_col >= len(row):
            continue
        name = str(row[name_col]).strip()
        if not name or name.lower() in {"device name", "nan", "none"}:
            continue
        if name.lower().startswith("bacnet"):
            continue
        network = re.sub(r"[^\d]", "", str(row[net_col]).strip()) if net_col < len(row) else ""
        if not network:
            continue
        key = (normalize_name(name), network)
        if key in seen:
            continue
        seen.add(key)
        devices.append({"device_name": name, "network": network})
    if not devices:
        raise ValueError("No device rows with a Network Number were found in the BACnet report.")
    return devices


def expand_bacnet_names(name: str) -> list[str]:
    text = str(name or "").strip()
    names = [text]
    match = _OS_RANGE.match(text)
    if not match:
        return names
    prefix = match.group(1).strip(" -_")
    start, end = int(match.group(2)), int(match.group(3))
    if end < start or end - start > 80:
        return names
    for number in range(start, end + 1):
        names.append(f"{prefix} OS-{number}".strip())
        names.append(f"{prefix} OS {number}".strip())
    return names


def bacnet_name_index(devices: list[dict[str, str]]) -> dict[str, str]:
    index: dict[str, str] = {}
    for device in devices:
        network = str(device.get("network") or "").strip()
        if not network:
            continue
        for variant in expand_bacnet_names(device.get("device_name") or ""):
            key = normalize_name(variant)
            if not key:
                continue
            previous = index.get(key)
            if previous and previous != network:
                continue
            index[key] = network
            compact = re.sub(r"[^A-Z0-9]+", "", key)
            if compact and compact not in index:
                index[compact] = network
    return index


def bacnet_os_index(devices: list[dict[str, str]]) -> dict[str, set[str]]:
    os_map: dict[str, set[str]] = defaultdict(set)
    for device in devices:
        network = str(device.get("network") or "").strip()
        if not network:
            continue
        for variant in expand_bacnet_names(device.get("device_name") or ""):
            for number in _OS_NUM.findall(variant):
                os_map[str(int(number))].add(network)
    return os_map


def row_network_number(
    row: MatchRow,
    index: dict[str, str],
    os_map: dict[str, set[str]] | None = None,
) -> str | None:
    values = [row.csv_name, row.pdf_name, row_code(row)]
    keys: list[str] = []
    for value in values:
        key = normalize_name(value)
        if key:
            keys.append(key)
            compact = re.sub(r"[^A-Z0-9]+", "", key)
            if compact:
                keys.append(compact)
    for key in keys:
        if key in index:
            return index[key]
    for key in keys:
        if len(key) < 6:
            continue
        hits = {network for device_key, network in index.items() if key in device_key or device_key in key}
        if len(hits) == 1:
            return next(iter(hits))
    os_map = os_map or {}
    for value in values:
        for number in _OS_NUM.findall(str(value or "")):
            networks = os_map.get(str(int(number))) or set()
            if len(networks) == 1:
                return next(iter(networks))
    return None


def write_bacnet_network_files(
    output_dir: Path,
    rows: list[MatchRow],
    devices: list[dict[str, str]] | None,
    summary: dict[str, Any],
    leaf_transform: dict[str, float] | None = None,
) -> None:
    for path in output_dir.glob("leaf_network_*.csv"):
        path.unlink(missing_ok=True)
    zip_path = output_dir / "leaf_by_network.zip"
    if zip_path.exists():
        zip_path.unlink()
    unmatched_path = output_dir / "bacnet_unmatched.csv"
    if unmatched_path.exists():
        unmatched_path.unlink()

    if not devices:
        summary.pop("bacnet_networks", None)
        summary.pop("bacnet_unmatched", None)
        return

    index = bacnet_name_index(devices)
    os_map = bacnet_os_index(devices)
    grouped: dict[str, list[MatchRow]] = {
        str(device.get("network") or "").strip(): []
        for device in devices
        if str(device.get("network") or "").strip()
    }
    unmatched: list[MatchRow] = []
    for row in rows:
        network = row_network_number(row, index, os_map)
        if network:
            grouped.setdefault(network, []).append(row)
        else:
            unmatched.append(row)

    networks = sorted((key for key in grouped if key), key=lambda value: (len(value), value))
    zip_files: list[Path] = []
    for network in networks:
        path = output_dir / f"leaf_network_{network}.csv"
        path.write_text(rows_to_leaf_csv(grouped[network], leaf_transform), encoding="utf-8")
        zip_files.append(path)
    unmatched_path.write_text(rows_to_csv(unmatched), encoding="utf-8")
    zip_files.append(unmatched_path)
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in zip_files:
            archive.write(path, arcname=path.name)
    summary["bacnet_networks"] = networks
    summary["bacnet_unmatched"] = len(unmatched)
    summary["bacnet_devices"] = len(devices)


def write_job_outputs(
    output_dir: Path,
    unnamed_pdf: Path,
    rows: list[MatchRow],
    summary: dict[str, Any],
    leaf_transform: dict[str, float] | None = None,
    pdf_only: list[MatchRow] | None = None,
    bacnet_devices: list[dict[str, str]] | None = None,
) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "coordinates.csv").write_text(rows_to_csv(rows), encoding="utf-8")
    (output_dir / "leaf_coordinates.csv").write_text(rows_to_leaf_csv(rows, leaf_transform), encoding="utf-8")
    (output_dir / "coordinates.json").write_text(rows_to_json(rows, summary), encoding="utf-8")
    unmatched = [r for r in rows if r.status == "unmatched"]
    unmatched_csv = rows_to_csv(unmatched)
    (output_dir / "leaf csv unmatched.csv").write_text(unmatched_csv, encoding="utf-8")
    (output_dir / "leaf_csv_unmatched.csv").write_text(unmatched_csv, encoding="utf-8")
    (output_dir / "pdf_only_coordinates.csv").write_text(rows_to_pdf_only_csv(pdf_only or []), encoding="utf-8")
    (output_dir / "same_name_locations.csv").write_text(
        rows_to_same_name_locations_csv(rows, pdf_only, leaf_transform), encoding="utf-8"
    )
    write_bacnet_network_files(output_dir, rows, bacnet_devices, summary, leaf_transform)
    stamp_unnamed_pdf(unnamed_pdf, output_dir / "stamped.pdf", rows, include_code=True)
    stamp_unnamed_pdf(unnamed_pdf, output_dir / "stamped_names.pdf", rows, include_code=False)


def stamp_unnamed_pdf(
    src_path: Path,
    dest_path: Path,
    rows: list[MatchRow],
    include_code: bool = True,
) -> None:
    doc = fitz.open(src_path)
    try:
        for row in rows:
            if row.status not in {"matched", "fuzzy"} or row.page is None:
                continue
            page = doc[row.page - 1]
            cx, cy = float(row.center_x or 0.0), float(row.center_y or 0.0)
            lines = _wrap_stamp_text(row.csv_name)
            if include_code:
                code = row_code(row)
                if code:
                    lines.extend(_wrap_stamp_text(code, max_chars=18))
            if not lines:
                continue
            fontsize = max(STAMP_FONT_SIZE, min(11.0, page.rect.width / 280.0))
            widths = [fitz.get_text_length(line, fontname="helv", fontsize=fontsize) for line in lines]
            pad_x, pad_y = 5.0, 3.5
            line_h = fontsize * 1.28
            width = max(widths) + pad_x * 2
            height = line_h * len(lines) + pad_y * 2
            rect = fitz.Rect(cx - width / 2, cy - height / 2, cx + width / 2, cy + height / 2)
            dx = max(page.rect.x0 - rect.x0, 0.0) + min(page.rect.x1 - rect.x1, 0.0)
            dy = max(page.rect.y0 - rect.y0, 0.0) + min(page.rect.y1 - rect.y1, 0.0)
            rect = rect + (dx, dy, dx, dy)
            page.draw_rect(rect, color=(0.05, 0.35, 0.18), fill=(1, 1, 1), width=0.5, overlay=True)
            baseline = rect.y0 + pad_y + fontsize * 0.92
            for index, line in enumerate(lines):
                text_width = widths[index] if index < len(widths) else fitz.get_text_length(line, fontname="helv", fontsize=fontsize)
                page.insert_text(
                    (rect.x0 + (rect.width - text_width) / 2, baseline + index * line_h),
                    line,
                    fontname="helv",
                    fontsize=fontsize,
                    color=(0.02, 0.18, 0.10),
                    overlay=True,
                )
        dest_path.parent.mkdir(parents=True, exist_ok=True)
        doc.save(dest_path, deflate=True, garbage=3)
    finally:
        doc.close()


def render_base_preview(pdf_path: Path, dest_path: Path) -> None:
    doc = fitz.open(pdf_path)
    try:
        page = doc[0]
        zoom = min(PREVIEW_MAX_SIDE / max(page.rect.width, 1), PREVIEW_MAX_SIDE / max(page.rect.height, 1), 2.2)
        pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
        dest_path.parent.mkdir(parents=True, exist_ok=True)
        pix.save(dest_path)
    finally:
        doc.close()


def rows_to_csv(rows: list[MatchRow]) -> str:
    buffer = io.StringIO()
    fieldnames = [
        "csv_name",
        "code",
        "pdf_name",
        "status",
        "score",
        "page",
        "x0",
        "y0",
        "x1",
        "y1",
        "center_x",
        "center_y",
        "polygon",
    ]
    extra_keys: list[str] = []
    reserved = set(fieldnames)
    for row in rows:
        for key in row.extra:
            if key not in extra_keys and key not in reserved and str(key).strip().lower() not in CODE_COLUMN_ALIASES:
                extra_keys.append(key)
    writer = csv.DictWriter(buffer, fieldnames=fieldnames + extra_keys)
    writer.writeheader()
    for row in rows:
        extra = {
            key: value
            for key, value in row.extra.items()
            if key not in reserved and str(key).strip().lower() not in CODE_COLUMN_ALIASES
        }
        payload = {
            "csv_name": row.csv_name,
            "code": row_code(row),
            "pdf_name": row.pdf_name,
            "status": row.status,
            "score": row.score,
            "page": row.page if row.page is not None else "",
            "x0": row.x0 if row.x0 is not None else "",
            "y0": row.y0 if row.y0 is not None else "",
            "x1": row.x1 if row.x1 is not None else "",
            "y1": row.y1 if row.y1 is not None else "",
            "center_x": row.center_x if row.center_x is not None else "",
            "center_y": row.center_y if row.center_y is not None else "",
            "polygon": row.polygon,
        }
        payload.update(extra)
        writer.writerow(payload)
    return buffer.getvalue()


LEAF_CSV_HEADERS = [
    "processor_id",
    "root_area",
    "root_subarea",
    "root_sub_subarea",
    "code",
    "name",
]


def rows_to_leaf_csv(rows: list[MatchRow], leaf_transform: dict[str, float] | None = None) -> str:
    scale = float((leaf_transform or {}).get("scale") or 1.0)
    tx = float((leaf_transform or {}).get("tx") or 0.0)
    ty = float((leaf_transform or {}).get("ty") or 0.0)
    remap = leaf_transform is not None
    point_lists = []
    for row in rows:
        points = polygon_points(row)
        if remap:
            points = [transform_point(x, y, scale, tx, ty) for x, y in points]
        # Export-only cleanup — match/overlay polygons stay raw.
        points = clean_leaf_ring(points)
        point_lists.append(points)
    max_points = max((len(points) for points in point_lists), default=0)
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(LEAF_CSV_HEADERS + [""] * max_points)
    for row, points in zip(rows, point_lists):
        prefix = [
            extra_value(row, "processor_id"),
            extra_value(row, "root_area"),
            extra_value(row, "root_subarea"),
            extra_value(row, "root_sub_subarea"),
            row_code(row),
            row.csv_name,
        ]
        coords = [format_xy(x, y) for x, y in points]
        coords.extend([""] * (max_points - len(coords)))
        writer.writerow(prefix + coords)
    return buffer.getvalue()


def rows_to_pdf_only_csv(rows: list[MatchRow]) -> str:
    point_lists = [polygon_points(row) for row in rows]
    max_points = max((len(points) for points in point_lists), default=0)
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["pdf_name", "page", "x0", "y0", "x1", "y1", "center_x", "center_y"] + [""] * max_points)
    for row, points in zip(rows, point_lists):
        coords = [format_xy(x, y) for x, y in points]
        coords.extend([""] * (max_points - len(coords)))
        writer.writerow(
            [
                row.pdf_name,
                row.page if row.page is not None else "",
                row.x0 if row.x0 is not None else "",
                row.y0 if row.y0 is not None else "",
                row.x1 if row.x1 is not None else "",
                row.y1 if row.y1 is not None else "",
                row.center_x if row.center_x is not None else "",
                row.center_y if row.center_y is not None else "",
            ]
            + coords
        )
    return buffer.getvalue()


def _coord_bounds(rows: Iterable[MatchRow]) -> tuple[float, float, float, float] | None:
    xs: list[float] = []
    ys: list[float] = []
    for row in rows:
        if row.center_x is None or row.center_y is None:
            continue
        xs.append(float(row.center_x))
        ys.append(float(row.center_y))
        if None not in (row.x0, row.y0, row.x1, row.y1):
            xs.extend([float(row.x0), float(row.x1)])
            ys.extend([float(row.y0), float(row.y1)])
    if not xs or not ys:
        return None
    return (min(xs), min(ys), max(xs), max(ys))


def plan_location(cx: float, cy: float, bounds: tuple[float, float, float, float]) -> str:
    minx, miny, maxx, maxy = bounds
    nx = (cx - minx) / max(maxx - minx, 1e-6)
    ny = (cy - miny) / max(maxy - miny, 1e-6)
    nx = min(max(nx, 0.0), 0.999)
    ny = min(max(ny, 0.0), 0.999)
    col = 0 if nx < 1 / 3 else 1 if nx < 2 / 3 else 2
    row = 0 if ny < 1 / 3 else 1 if ny < 2 / 3 else 2
    return [
        ["top left", "center top", "top right"],
        ["middle left", "center", "middle right"],
        ["down left", "center down", "down right"],
    ][row][col]


def rows_to_same_name_locations_csv(
    rows: list[MatchRow],
    pdf_only: list[MatchRow] | None = None,
    leaf_transform: dict[str, float] | None = None,
) -> str:
    located = [
        row
        for row in rows
        if row.status in {"matched", "fuzzy"}
        and row.center_x is not None
        and row.center_y is not None
        and str(row.csv_name or "").strip()
    ]
    bounds = _coord_bounds(located)
    grouped: dict[str, list[MatchRow]] = defaultdict(list)
    for row in located:
        key = normalize_name(row.csv_name)
        if key:
            grouped[key].append(row)

    duplicates: list[MatchRow] = []
    locations: list[str] = []
    occurrences: list[int] = []
    if bounds is not None:
        named_groups = sorted(grouped.items(), key=lambda item: item[0])
        for _key, items in named_groups:
            if len(items) < 2:
                continue
            items.sort(key=lambda row: (row.page or 0, float(row.center_x or 0), float(row.center_y or 0)))
            for index, row in enumerate(items, start=1):
                duplicates.append(row)
                locations.append(plan_location(float(row.center_x), float(row.center_y), bounds))
                occurrences.append(index)

    scale = float((leaf_transform or {}).get("scale") or 1.0)
    tx = float((leaf_transform or {}).get("tx") or 0.0)
    ty = float((leaf_transform or {}).get("ty") or 0.0)
    remap = leaf_transform is not None
    point_lists = []
    for row in duplicates:
        points = polygon_points(row)
        if remap:
            points = [transform_point(x, y, scale, tx, ty) for x, y in points]
        point_lists.append(points)
    max_points = max((len(points) for points in point_lists), default=0)
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(LEAF_CSV_HEADERS + ["location", "occurrence"] + [""] * max_points)
    for row, points, location, occurrence in zip(duplicates, point_lists, locations, occurrences):
        prefix = [
            extra_value(row, "processor_id"),
            extra_value(row, "root_area"),
            extra_value(row, "root_subarea"),
            extra_value(row, "root_sub_subarea"),
            row_code(row),
            row.csv_name or row.pdf_name,
            location,
            occurrence,
        ]
        coords = [format_xy(x, y) for x, y in points]
        coords.extend([""] * (max_points - len(coords)))
        writer.writerow(prefix + coords)
    return buffer.getvalue()


def rows_to_json(rows: list[MatchRow], summary: dict[str, Any]) -> str:
    return json.dumps(
        {
            "summary": summary,
            "areas": [
                {
                    **{k: v for k, v in asdict(row).items() if k != "extra"},
                    "code": row_code(row),
                    **{
                        key: value
                        for key, value in row.extra.items()
                        if str(key).strip().lower() not in CODE_COLUMN_ALIASES
                    },
                }
                for row in rows
            ],
        },
        indent=2,
    )


def summarize(rows: list[MatchRow], labels: list[Label], polygons: list[AreaPolygon], polygon_mode: str) -> dict[str, Any]:
    return {
        "labels_found": len(labels),
        "polygons_found": len(polygons),
        "polygon_mode": polygon_mode,
        "matched": sum(1 for r in rows if r.status in {"matched", "fuzzy"}),
        "fuzzy": sum(1 for r in rows if r.status == "fuzzy"),
        "unmatched": sum(1 for r in rows if r.status == "unmatched"),
        "duplicate": sum(1 for r in rows if r.status == "duplicate"),
        "csv_rows": len(rows),
        "pdf_only": 0,
    }


def _stored_rows(rows: list[MatchRow]) -> list[dict[str, Any]]:
    stored = []
    for row in rows:
        item = asdict(row)
        if row.polygon:
            try:
                item["polygon"] = json.loads(row.polygon)
            except json.JSONDecodeError:
                item["polygon"] = []
        stored.append(item)
    return stored


def _overlay_payload(
    polygons: list[AreaPolygon],
    unnamed_polygons: list[AreaPolygon],
    rows: list[MatchRow],
    named_page: dict[str, float],
    unnamed_page: dict[str, float],
    unnamed_pdf: Path,
    summary: dict[str, Any],
    leftover: list[MatchRow] | None = None,
) -> dict[str, Any]:
    fit = compute_fit_transform(polygons, unnamed_polygons, named_page, unnamed_page)
    return {
        "unnamed_pdf": str(unnamed_pdf),
        "named_page": named_page,
        "page": unnamed_page,
        "fit": fit,
        "summary": summary,
        "polygons": [
            {"page": p.page, "points": [[round(x, 2), round(y, 2)] for x, y in p.points]}
            for p in polygons
            if p.page == 1
        ],
        "unnamed_polygons": [
            {"page": p.page, "points": [[round(x, 2), round(y, 2)] for x, y in p.points]}
            for p in unnamed_polygons
            if p.page == 1
        ],
        "rows": _stored_rows(rows),
        "pdf_only_rows": _stored_rows(leftover or []),
    }


def process_job(
    named_pdf: Path,
    unnamed_pdf: Path,
    csv_bytes: bytes,
    output_dir: Path,
    name_column: str | None = None,
    green_only: bool = True,
    clean_pdf: Path | None = None,
    bacnet_bytes: bytes | None = None,
) -> dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=True)
    named_doc = fitz.open(named_pdf)
    unnamed_doc = fitz.open(unnamed_pdf)
    try:
        labels = extract_labels(named_doc)
        polygons, polygon_mode = extract_polygons(named_doc, green_only=green_only)
        unnamed_polygons, unnamed_mode = extract_polygons(unnamed_doc, green_only=green_only)
        named_page = page_metrics(named_doc[0])
        unnamed_page = page_metrics(unnamed_doc[0])
        if not polygons:
            polygons = unnamed_polygons
            polygon_mode = f"{unnamed_mode}_from_unnamed"
    finally:
        named_doc.close()
        unnamed_doc.close()

    clean_fit: dict[str, float] | None = None
    clean_page: dict[str, float] | None = None
    if clean_pdf is not None:
        clean_doc = fitz.open(clean_pdf)
        try:
            clean_polygons, _ = extract_polygons(clean_doc, green_only=green_only)
            clean_page = page_metrics(clean_doc[0])
        finally:
            clean_doc.close()
        clean_fit = compute_fit_transform(unnamed_polygons, clean_polygons, unnamed_page, clean_page)

    label_map = build_label_map(labels, polygons)
    frame, used_column = read_processor_csv(csv_bytes, name_column)
    rows = match_csv_to_labels(frame, used_column, label_map)
    leftover = pdf_only_rows(label_map, rows)
    bacnet_devices: list[dict[str, str]] | None = None
    if bacnet_bytes:
        bacnet_devices = parse_bacnet_report(bacnet_bytes)
    summary = summarize(rows, labels, polygons, polygon_mode)
    summary["name_column"] = used_column
    summary["unnamed_polygons"] = len(unnamed_polygons)
    summary["pdf_only"] = len(leftover)
    if clean_fit:
        summary["clean_layout"] = True
        summary["clean_fit"] = clean_fit

    overlay = _overlay_payload(
        polygons, unnamed_polygons, rows, named_page, unnamed_page, unnamed_pdf, summary, leftover
    )
    if clean_pdf is not None:
        overlay["clean_pdf"] = str(clean_pdf)
        overlay["clean_page"] = clean_page
        overlay["clean_fit"] = clean_fit
    if bacnet_devices:
        overlay["bacnet_devices"] = bacnet_devices
    (output_dir / "overlay.json").write_text(json.dumps(overlay), encoding="utf-8")
    fit = overlay["fit"]
    aligned = transform_rows(rows, fit["scale"], fit["tx"], fit["ty"])
    aligned_pdf_only = transform_rows(leftover, fit["scale"], fit["tx"], fit["ty"])
    summary["alignment"] = {"scale": fit["scale"], "tx": fit["tx"], "ty": fit["ty"]}
    write_job_outputs(
        output_dir,
        unnamed_pdf,
        aligned,
        summary,
        leaf_transform=clean_fit,
        pdf_only=aligned_pdf_only,
        bacnet_devices=bacnet_devices,
    )
    render_base_preview(unnamed_pdf, output_dir / "preview.png")

    return {
        "summary": summary,
        "rows": public_rows(aligned),
        "overlay": {
            "page": unnamed_page,
            "fit": overlay["fit"],
            "polygons": overlay["polygons"],
            "matches": [
                {
                    "row_index": i,
                    "csv_name": r.csv_name,
                    "code": row_code(r),
                    **overlay_extra_fields(r),
                    "status": r.status,
                    "x0": r.x0,
                    "y0": r.y0,
                    "x1": r.x1,
                    "y1": r.y1,
                    "center_x": r.center_x,
                    "center_y": r.center_y,
                    "polygon": json.loads(r.polygon) if r.polygon else [],
                }
                for i, r in enumerate(rows)
                if r.status in {"matched", "fuzzy"} and r.page == 1
            ],
        },
    }


def apply_area_edits(rows: list[MatchRow], edits: list[dict[str, Any]] | None) -> list[MatchRow]:
    if not edits:
        return rows
    extra_keys = ("processor_id", "root_area", "root_subarea", "root_sub_subarea")
    updated = list(rows)
    for edit in edits:
        try:
            idx = int(edit.get("row_index"))
        except (TypeError, ValueError):
            continue
        if idx < 0 or idx >= len(updated):
            continue
        row = updated[idx]
        if row.status not in {"matched", "fuzzy"}:
            continue
        new_name = edit.get("csv_name")
        if new_name is not None:
            new_name = str(new_name).strip() or row.csv_name
        extra = dict(row.extra or {})
        if edit.get("code") is not None:
            extra["code"] = str(edit.get("code") or "").strip()
        extra_edited = False
        for key in extra_keys:
            if edit.get(key) is not None:
                extra[key] = str(edit.get(key) or "").strip()
                extra_edited = True
        points: list[tuple[float, float]] = []
        for pt in edit.get("polygon") or []:
            if isinstance(pt, (list, tuple)) and len(pt) >= 2:
                points.append((float(pt[0]), float(pt[1])))
        has_box = None not in (edit.get("x0"), edit.get("y0"), edit.get("x1"), edit.get("y1"))
        if len(points) < 2 and not has_box:
            if new_name is None and edit.get("code") is None and not extra_edited:
                continue
            updated[idx] = MatchRow(
                csv_name=new_name if new_name is not None else row.csv_name,
                pdf_name=row.pdf_name,
                status=row.status,
                score=row.score,
                page=row.page,
                x0=row.x0,
                y0=row.y0,
                x1=row.x1,
                y1=row.y1,
                center_x=row.center_x,
                center_y=row.center_y,
                polygon=row.polygon,
                extra=extra,
            )
            continue
        if len(points) >= 2:
            xs = [x for x, _ in points]
            ys = [y for _, y in points]
            x0, x1 = min(xs), max(xs)
            y0, y1 = min(ys), max(ys)
            cx = sum(xs) / len(xs)
            cy = sum(ys) / len(ys)
            polygon = json.dumps([[round(x, 2), round(y, 2)] for x, y in points])
        else:
            x0, x1 = float(edit["x0"]), float(edit["x1"])
            y0, y1 = float(edit["y0"]), float(edit["y1"])
            cx = float(edit["center_x"]) if edit.get("center_x") is not None else (x0 + x1) / 2.0
            cy = float(edit["center_y"]) if edit.get("center_y") is not None else (y0 + y1) / 2.0
            polygon = json.dumps([
                [round(x0, 2), round(y0, 2)],
                [round(x1, 2), round(y0, 2)],
                [round(x1, 2), round(y1, 2)],
                [round(x0, 2), round(y1, 2)],
            ])
        updated[idx] = MatchRow(
            csv_name=new_name if new_name is not None else row.csv_name,
            pdf_name=row.pdf_name,
            status=row.status,
            score=row.score,
            page=row.page,
            x0=round(min(x0, x1), 2),
            y0=round(min(y0, y1), 2),
            x1=round(max(x0, x1), 2),
            y1=round(max(y0, y1), 2),
            center_x=round(cx, 2),
            center_y=round(cy, 2),
            polygon=polygon,
            extra=extra,
        )
    return updated


def rows_from_added_areas(items: list[dict[str, Any]] | None) -> list[MatchRow]:
    added: list[MatchRow] = []
    for item in items or []:
        name = str(item.get("csv_name") or "").strip()
        if not name:
            continue
        extra: dict[str, Any] = {}
        code = str(item.get("code") or "").strip()
        if code:
            extra["code"] = code
        for key in ("processor_id", "root_area", "root_subarea", "root_sub_subarea"):
            value = str(item.get(key) or "").strip()
            if value:
                extra[key] = value
        points: list[tuple[float, float]] = []
        for pt in item.get("polygon") or []:
            if isinstance(pt, (list, tuple)) and len(pt) >= 2:
                points.append((float(pt[0]), float(pt[1])))
        if len(points) < 2:
            if None in (item.get("x0"), item.get("y0"), item.get("x1"), item.get("y1")):
                continue
            x0, y0 = float(item["x0"]), float(item["y0"])
            x1, y1 = float(item["x1"]), float(item["y1"])
            points = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
        xs = [x for x, _ in points]
        ys = [y for _, y in points]
        x0, x1 = min(xs), max(xs)
        y0, y1 = min(ys), max(ys)
        added.append(
            MatchRow(
                csv_name=name,
                pdf_name=name,
                status="matched",
                score=100.0,
                page=int(item.get("page") or 1),
                x0=round(x0, 2),
                y0=round(y0, 2),
                x1=round(x1, 2),
                y1=round(y1, 2),
                center_x=round(sum(xs) / len(xs), 2),
                center_y=round(sum(ys) / len(ys), 2),
                polygon=json.dumps([[round(x, 2), round(y, 2)] for x, y in points]),
                extra=extra,
            )
        )
    return added


def apply_alignment(
    output_dir: Path,
    scale: float,
    tx: float,
    ty: float,
    edits: list[dict[str, Any]] | None = None,
    added_areas: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    overlay_path = output_dir / "overlay.json"
    if not overlay_path.exists():
        raise ValueError("No overlay data found. Process the PDFs first.")
    overlay = json.loads(overlay_path.read_text(encoding="utf-8"))
    unnamed_pdf = Path(overlay["unnamed_pdf"])
    if not unnamed_pdf.exists():
        raise ValueError("Original without-name PDF is missing.")
    original_rows = apply_area_edits(rows_from_stored(overlay["rows"]), edits)
    original_rows = original_rows + rows_from_added_areas(added_areas)
    aligned = transform_rows(original_rows, scale, tx, ty)
    aligned_pdf_only = transform_rows(rows_from_stored(overlay.get("pdf_only_rows") or []), scale, tx, ty)
    summary = overlay.get("summary") or {}
    summary["alignment"] = {
        "scale": scale,
        "tx": tx,
        "ty": ty,
        "edits": len(edits or []),
        "added": len(added_areas or []),
    }
    leaf_transform = overlay.get("clean_fit")
    write_job_outputs(
        output_dir,
        unnamed_pdf,
        aligned,
        summary,
        leaf_transform=leaf_transform,
        pdf_only=aligned_pdf_only,
        bacnet_devices=overlay.get("bacnet_devices"),
    )
    overlay["applied"] = {"scale": scale, "tx": tx, "ty": ty, "edits": len(edits or [])}
    overlay["applied_edits"] = edits or []
    overlay["added_areas"] = added_areas or []
    overlay_path.write_text(json.dumps(overlay), encoding="utf-8")
    return {
        "summary": summary,
        "rows": public_rows(aligned),
        "alignment": {"scale": scale, "tx": tx, "ty": ty, "edits": len(edits or [])},
    }


def apply_bacnet_report(output_dir: Path, bacnet_bytes: bytes) -> dict[str, Any]:
    overlay_path = output_dir / "overlay.json"
    if not overlay_path.exists():
        raise ValueError("No overlay data found. Process the PDFs first.")
    devices = parse_bacnet_report(bacnet_bytes)
    overlay = json.loads(overlay_path.read_text(encoding="utf-8"))
    unnamed_pdf = Path(overlay["unnamed_pdf"])
    if not unnamed_pdf.exists():
        raise ValueError("Original without-name PDF is missing.")
    applied = overlay.get("applied") or overlay.get("fit") or {"scale": 1.0, "tx": 0.0, "ty": 0.0}
    scale = float(applied.get("scale") or 1.0)
    tx = float(applied.get("tx") or 0.0)
    ty = float(applied.get("ty") or 0.0)
    original_rows = apply_area_edits(rows_from_stored(overlay["rows"]), overlay.get("applied_edits") or [])
    original_rows = original_rows + rows_from_added_areas(overlay.get("added_areas") or [])
    aligned = transform_rows(original_rows, scale, tx, ty)
    aligned_pdf_only = transform_rows(rows_from_stored(overlay.get("pdf_only_rows") or []), scale, tx, ty)
    summary = overlay.get("summary") or {}
    leaf_transform = overlay.get("clean_fit")
    overlay["bacnet_devices"] = devices
    write_job_outputs(
        output_dir,
        unnamed_pdf,
        aligned,
        summary,
        leaf_transform=leaf_transform,
        pdf_only=aligned_pdf_only,
        bacnet_devices=devices,
    )
    overlay["summary"] = summary
    overlay_path.write_text(json.dumps(overlay), encoding="utf-8")
    return {
        "summary": summary,
        "rows": public_rows(aligned),
        "bacnet_networks": summary.get("bacnet_networks") or [],
    }
