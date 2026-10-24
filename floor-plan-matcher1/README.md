# Floor Plan Area Matcher

Match area names from a processor CSV to a **with-name** floor-plan PDF, extract the green outline coordinates, and write those names and coordinates onto the **without-name** PDF.

## What it does

1. Reads labels such as `WS-OS-01` from the named PDF.
2. Finds the green area outlines around those labels.
3. Matches CSV area names to those labels.
4. Exports `coordinates.csv` / `coordinates.json`.
5. Stamps the matched name and center coordinate onto the unnamed PDF.

## Setup

```powershell
cd C:\Users\Chandana\Documents\floor-plan-matcher
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python run.py
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000).

## Website usage

1. Upload the with-name PDF, without-name PDF, and processor CSV.
2. Confirm the name column if it is not auto-detected.
3. Click **Match and write coordinates**.
4. Align the overlay if the boxes are slightly offset:
   - **Fit** — auto-align named outlines to the unnamed plan
   - **Increase / Decrease** — scale the overlay (mouse wheel also works)
   - **Drag** — move the overlay; arrow keys nudge 1pt (Shift = 5pt)
   - **Apply alignment** — rewrite coordinates and `stamped.pdf`
5. Download:
   - `coordinates.csv` — bounding box and polygon for each CSV area
   - `stamped.pdf` — unnamed plan with names and coordinates written on it
   - `unmatched.csv` — CSV rows that did not match a PDF label
6. Optional next step — **Clean / fix coordinates**:
   - Opens the Area Coordinate Fixer at `/cleaner/?job_id=...`
   - Loads `leaf_coordinates.csv` automatically
   - Removes extra points, review, edit, then download cleaned CSV
   - Matching and cleaning engines stay separate; only the handoff is shared

Use **Create sample files** to generate a demo plan if you want to test first.

## Combined app (matcher + cleaner)

Matcher logic lives in `app/processor.py` (unchanged).  
Cleaner logic lives in `cleaner/src/lib/` (same as Area Coordinate Fixer).

```powershell
# Backend (matcher UI + API)
python run.py

# Build cleaner UI into static/cleaner (once, or after cleaner changes)
cd cleaner
npm install
npm run build
```

Then open:
- Matcher: http://127.0.0.1:8000/
- Cleaner: http://127.0.0.1:8000/cleaner/

For cleaner UI development with hot reload:

```powershell
# terminal 1
python run.py
# terminal 2
cd cleaner
npm run dev
```

Dev cleaner runs on http://127.0.0.1:5176/cleaner/ and proxies `/api` to the matcher.

## CSV format

Any CSV with an area-name column works. These column names are auto-detected: `name`, `area_name`, `space`, `label`, `room`, `code`.

Example:

```csv
area_name,floor,type
WS-OS-01,1st Floor,space
MEETING ROOM OS-02,1st Floor,space
```

## Command line

```powershell
python -m app.cli --named sample\with_name.pdf --unnamed sample\without_name.pdf --csv sample\processor.csv --out data\cli-output
```

## Notes

- Coordinates are PDF points. Origin is the top-left of the page.
- Green outlines are detected by stroke/fill color. If your CAD export uses a different highlight color, uncheck **Green outlines only**.
- Matching is exact after normalization, then fuzzy (`WS OS 01` vs `WS-OS-01`).
- Unmatched rows are never stamped onto a guessed location.
- `leaf_coordinates.csv` (and per-network leaf files) run a light vertex cleanup on **export only** (near-duplicates, collinear extras, near-close tails). Match / align / overlay / `coordinates.csv` / stamped PDFs are unchanged. Use Area Coordinate Fixer for review and manual edits.
