"""FastAPI app for floor-plan area matching."""

from __future__ import annotations

import json
import re
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app.processor import apply_alignment, apply_bacnet_report, process_job, read_processor_csv
from app.sample_data import generate_sample_files

ROOT = Path(__file__).resolve().parent.parent
STATIC_DIR = ROOT / "static"
CLEANER_DIR = STATIC_DIR / "cleaner"
DATA_DIR = ROOT / "data"
JOBS_DIR = DATA_DIR / "jobs"
SAMPLE_DIR = ROOT / "sample"

app = FastAPI(title="Floor Plan Area Matcher", version="1.0.0")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
if (CLEANER_DIR / "assets").exists():
    app.mount("/cleaner/assets", StaticFiles(directory=CLEANER_DIR / "assets"), name="cleaner_assets")

_LEAF_NETWORK_FILE = re.compile(r"^leaf_network_\d{1,12}\.csv$")


def _job_downloads(job_id: str, networks: list[str] | None = None) -> dict[str, Any]:
    downloads: dict[str, Any] = {
        "coordinates_csv": f"/api/jobs/{job_id}/coordinates.csv",
        "leaf_coordinates_csv": f"/api/jobs/{job_id}/leaf_coordinates.csv",
        "coordinates_json": f"/api/jobs/{job_id}/coordinates.json",
        "unmatched_csv": f"/api/jobs/{job_id}/{quote('leaf csv unmatched.csv')}",
        "pdf_only_csv": f"/api/jobs/{job_id}/pdf_only_coordinates.csv",
        "same_name_locations_csv": f"/api/jobs/{job_id}/same_name_locations.csv",
        "stamped_pdf": f"/api/jobs/{job_id}/stamped.pdf",
        "stamped_names_pdf": f"/api/jobs/{job_id}/stamped_names.pdf",
        "preview_png": f"/api/jobs/{job_id}/preview.png",
    }
    if networks:
        downloads["bacnet_zip"] = f"/api/jobs/{job_id}/leaf_by_network.zip"
        downloads["bacnet_unmatched_csv"] = f"/api/jobs/{job_id}/bacnet_unmatched.csv"
        downloads["leaf_network_csvs"] = {
            network: f"/api/jobs/{job_id}/leaf_network_{network}.csv" for network in networks
        }
    return downloads


class AreaEdit(BaseModel):
    row_index: int
    x0: float | None = None
    y0: float | None = None
    x1: float | None = None
    y1: float | None = None
    center_x: float | None = None
    center_y: float | None = None
    polygon: list[list[float]] = Field(default_factory=list)
    csv_name: str | None = None
    code: str | None = None
    processor_id: str | None = None
    root_area: str | None = None
    root_subarea: str | None = None
    root_sub_subarea: str | None = None


class AddedArea(BaseModel):
    csv_name: str
    code: str = ""
    processor_id: str = ""
    root_area: str = ""
    root_subarea: str = ""
    root_sub_subarea: str = ""
    page: int = 1
    x0: float | None = None
    y0: float | None = None
    x1: float | None = None
    y1: float | None = None
    center_x: float | None = None
    center_y: float | None = None
    polygon: list[list[float]] = Field(default_factory=list)


class AlignRequest(BaseModel):
    scale: float = Field(default=1.0, ge=0.25, le=4.0)
    tx: float = 0.0
    ty: float = 0.0
    edits: list[AreaEdit] = Field(default_factory=list)
    added_areas: list[AddedArea] = Field(default_factory=list)


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/cleaner")
@app.get("/cleaner/")
@app.get("/cleaner/index.html")
def cleaner_app() -> FileResponse:
    """Serve the Area Coordinate Fixer UI (built React app). Matching logic is unchanged."""
    index_path = CLEANER_DIR / "index.html"
    if not index_path.exists():
        raise HTTPException(
            status_code=503,
            detail="Coordinate cleaner UI is not built yet. From floor-plan-matcher/cleaner run: npm install && npm run build",
        )
    return FileResponse(index_path)


@app.get("/favicon.ico", include_in_schema=False)
def favicon() -> FileResponse:
    return FileResponse(STATIC_DIR / "favicon.svg", media_type="image/svg+xml")


@app.post("/api/preview-csv")
async def preview_csv(csv_file: UploadFile = File(...)) -> dict:
    content = await csv_file.read()
    try:
        frame, column = read_processor_csv(content)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    names = frame[column].head(25).tolist()
    columns = [c for c in frame.columns if not str(c).startswith("_")]
    return {
        "columns": columns,
        "name_column": column,
        "row_count": int(len(frame)),
        "preview_names": names,
    }


@app.post("/api/process")
async def process(
    named_pdf: UploadFile = File(...),
    unnamed_pdf: UploadFile = File(...),
    csv_file: UploadFile = File(...),
    clean_pdf: UploadFile | None = File(default=None),
    bacnet_csv: UploadFile | None = File(default=None),
    name_column: str | None = Form(default=None),
    green_only: bool = Form(default=True),
) -> dict:
    job_id = uuid.uuid4().hex[:12]
    job_dir = JOBS_DIR / job_id
    uploads = job_dir / "uploads"
    outputs = job_dir / "outputs"
    uploads.mkdir(parents=True, exist_ok=True)

    named_path = uploads / _safe_name(named_pdf.filename, "with_name.pdf")
    unnamed_path = uploads / _safe_name(unnamed_pdf.filename, "without_name.pdf")
    csv_path = uploads / _safe_name(csv_file.filename, "processor.csv")

    named_path.write_bytes(await named_pdf.read())
    unnamed_path.write_bytes(await unnamed_pdf.read())
    csv_bytes = await csv_file.read()
    csv_path.write_bytes(csv_bytes)

    clean_path = None
    if clean_pdf is not None and clean_pdf.filename:
        clean_path = uploads / _safe_name(clean_pdf.filename, "clean_layout.pdf")
        clean_path.write_bytes(await clean_pdf.read())

    bacnet_bytes = None
    if bacnet_csv is not None and bacnet_csv.filename:
        bacnet_path = uploads / _safe_name(bacnet_csv.filename, "bacnet.csv")
        bacnet_bytes = await bacnet_csv.read()
        bacnet_path.write_bytes(bacnet_bytes)

    try:
        result = process_job(
            named_pdf=named_path,
            unnamed_pdf=unnamed_path,
            csv_bytes=csv_bytes,
            output_dir=outputs,
            name_column=name_column or None,
            green_only=green_only,
            clean_pdf=clean_path,
            bacnet_bytes=bacnet_bytes,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    result["job_id"] = job_id
    result["downloads"] = _job_downloads(job_id, result.get("summary", {}).get("bacnet_networks"))
    return result


@app.post("/api/jobs/{job_id}/align")
def align(job_id: str, body: AlignRequest) -> dict:
    output_dir = JOBS_DIR / job_id / "outputs"
    if not output_dir.exists():
        raise HTTPException(status_code=404, detail="Job not found. Process the PDFs first.")
    try:
        result = apply_alignment(
            output_dir,
            body.scale,
            body.tx,
            body.ty,
            edits=[edit.model_dump() for edit in body.edits],
            added_areas=[item.model_dump() for item in body.added_areas],
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    result["job_id"] = job_id
    result["downloads"] = _job_downloads(job_id, result.get("summary", {}).get("bacnet_networks"))
    return result


@app.post("/api/jobs/{job_id}/bacnet")
async def split_bacnet(job_id: str, bacnet_csv: UploadFile = File(...)) -> dict:
    output_dir = JOBS_DIR / job_id / "outputs"
    if not output_dir.exists():
        raise HTTPException(status_code=404, detail="Job not found. Process the PDFs first.")
    try:
        result = apply_bacnet_report(output_dir, await bacnet_csv.read())
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    result["job_id"] = job_id
    result["downloads"] = _job_downloads(job_id, result.get("summary", {}).get("bacnet_networks"))
    return result


@app.get("/api/jobs/{job_id}/info")
def job_info(job_id: str) -> dict[str, Any]:
    """Returns metadata and available CSV files for a matcher job."""
    outputs_dir = JOBS_DIR / job_id / "outputs"
    if not outputs_dir.exists():
        raise HTTPException(status_code=404, detail="Job not found. Process the PDFs first.")

    overlay_path = outputs_dir / "overlay.json"
    networks: list[str] = []
    if overlay_path.exists():
        try:
            overlay = json.loads(overlay_path.read_text(encoding="utf-8"))
            networks = overlay.get("summary", {}).get("bacnet_networks") or []
        except Exception:
            pass

    found_networks = [
        f.name.replace("leaf_network_", "").replace(".csv", "")
        for f in outputs_dir.glob("leaf_network_*.csv")
    ]
    all_networks = sorted(list(set(networks) | set(found_networks)), key=lambda x: int(x) if x.isdigit() else x)

    csv_files: list[dict[str, str]] = [
        {"filename": "leaf_coordinates.csv", "label": "Master leaf coordinates (All areas)"}
    ]

    for net in all_networks:
        fn = f"leaf_network_{net}.csv"
        if (outputs_dir / fn).exists():
            csv_files.append({"filename": fn, "label": f"Network {net} CSV"})

    if (outputs_dir / "bacnet_unmatched.csv").exists():
        csv_files.append({"filename": "bacnet_unmatched.csv", "label": "BACnet Unmatched CSV"})

    return {
        "job_id": job_id,
        "networks": all_networks,
        "csv_files": csv_files,
        "downloads": _job_downloads(job_id, all_networks),
    }


@app.get("/api/jobs/{job_id}/page.json")
def job_page_metrics(job_id: str) -> dict[str, Any]:
    """Page size used for leaf_coordinates (PyMuPDF page.rect) — for cleaner overlay fit."""
    path = JOBS_DIR / job_id / "outputs" / "overlay.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Job not found. Process the PDFs first.")
    try:
        overlay = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Could not read overlay: {exc}") from exc
    page = overlay.get("page") or {}
    return {
        "x0": float(page.get("x0") or 0.0),
        "y0": float(page.get("y0") or 0.0),
        "width": float(page.get("width") or 0.0),
        "height": float(page.get("height") or 0.0),
        "job_id": job_id,
    }


@app.get("/api/jobs/{job_id}/{filename}")
def download(job_id: str, filename: str) -> FileResponse:
    filename = unquote(filename)
    allowed = {
        "coordinates.csv",
        "leaf_coordinates.csv",
        "coordinates.json",
        "leaf csv unmatched.csv",
        "leaf_csv_unmatched.csv",
        "leafcsv unmatched.csv",
        "csv unmatched.csv",
        "unmatched.csv",
        "pdf_only_coordinates.csv",
        "same_name_locations.csv",
        "bacnet_unmatched.csv",
        "leaf_by_network.zip",
        "stamped.pdf",
        "stamped_names.pdf",
        "preview.png",
    }
    aliases = {
        "leafcsv unmatched.csv": "leaf csv unmatched.csv",
        "leaf_csv_unmatched.csv": "leaf csv unmatched.csv",
        "csv unmatched.csv": "leaf csv unmatched.csv",
        "unmatched.csv": "leaf csv unmatched.csv",
    }
    if filename not in allowed and not _LEAF_NETWORK_FILE.match(filename):
        raise HTTPException(status_code=404, detail="Unknown file.")
    stored_name = aliases.get(filename, filename)
    path = JOBS_DIR / job_id / "outputs" / stored_name
    if not path.exists() and stored_name != filename:
        path = JOBS_DIR / job_id / "outputs" / filename
    if not path.exists():
        raise HTTPException(status_code=404, detail="File not found. Process the PDFs first.")
    if filename.endswith(".zip"):
        media = "application/zip"
    elif filename.endswith(".json"):
        media = "application/json"
    elif filename.endswith(".pdf"):
        media = "application/pdf"
    elif filename.endswith(".png"):
        media = "image/png"
    else:
        media = "text/csv"
    return FileResponse(
        path,
        media_type=media,
        filename=filename,
        headers={"Cache-Control": "no-store, max-age=0"},
    )


@app.post("/api/sample")
def create_sample() -> dict:
    files = generate_sample_files(SAMPLE_DIR)
    return {
        "message": "Sample files created in the sample folder.",
        "files": files,
        "downloads": {
            "with_name": "/api/sample/with_name.pdf",
            "without_name": "/api/sample/without_name.pdf",
            "csv": "/api/sample/processor.csv",
        },
    }


@app.get("/api/sample/{filename}")
def download_sample(filename: str) -> FileResponse:
    allowed = {"with_name.pdf", "without_name.pdf", "processor.csv"}
    if filename not in allowed:
        raise HTTPException(status_code=404, detail="Unknown sample file.")
    if not SAMPLE_DIR.exists():
        generate_sample_files(SAMPLE_DIR)
    path = SAMPLE_DIR / filename
    if not path.exists():
        generate_sample_files(SAMPLE_DIR)
    return FileResponse(path, filename=filename)


def _safe_name(name: str | None, fallback: str) -> str:
    raw = Path(name or fallback).name
    if not raw or raw in {".", ".."}:
        return fallback
    return raw
