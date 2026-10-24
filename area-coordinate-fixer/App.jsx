import { useEffect, useMemo, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { applyCleanup, buildExportForSlot, downloadTextFile, exportCleanedCsv, mergeParsedCsvs, parseAreaCsv } from "./lib/csv.js";
import { defaultCleanOptions } from "./lib/cleanPolygon.js";
import { bbox, centroid, countSelfIntersections, shoelaceArea, vertexLabel } from "./lib/geometry.js";
import { getAreasCoordinateExtent, resolveFloorPlanPageDims } from "./lib/pageDims.js";
import "./App.css";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

function statusLabel(status) {
  if (status === "needs-review") return "needs review";
  return status;
}

function isReviewArea(area) {
  return area.status === "needs-review" || area.status === "invalid";
}

function isCleanedArea(area) {
  return area.status === "clean";
}

function cycleLabel(kind, count, index) {
  const plural = count === 1 ? "area" : "areas";
  if (!count) return kind === "cleaned" ? "No cleaned areas" : "No areas to review";
  if (index < 0) return `${kind === "cleaned" ? "Cleaned" : "Review"} ${count} ${plural}`;
  if (count === 1) return kind === "cleaned" ? "Viewing 1 cleaned area" : "Reviewing 1 area";
  return `Next ${kind} area (${index + 1} of ${count})`;
}

function polygonPoints(ring) {
  return ring.map((p) => `${p.x},${p.y}`).join(" ");
}

function slotCoordSummary(parsed) {
  if (!parsed?.areas?.length) return "";
  const drawn = parsed.areas.filter((area) => (area.rings || []).some((ring) => ring.length));
  return `${drawn.length} / ${parsed.areas.length} areas have coordinates`;
}

function makePoint(x, y) {
  return { x, y, raw: `${x}~${y}` };
}

function svgEventPoint(svg, event) {
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const pt = svg.createSVGPoint();
  pt.x = event.clientX;
  pt.y = event.clientY;
  const mapped = pt.matrixTransform(ctm.inverse());
  return { x: mapped.x, y: mapped.y };
}

function closestPointOnSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return { x: a.x, y: a.y, dist2: (p.x - a.x) ** 2 + (p.y - a.y) ** 2 };
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  const x = a.x + t * dx;
  const y = a.y + t * dy;
  return { x, y, dist2: (p.x - x) ** 2 + (p.y - y) ** 2 };
}

function findInsertOnNearestEdge(rings, p) {
  let best = null;
  (rings || []).forEach((ring, ringIndex) => {
    if (!ring.length) return;
    for (let i = 0; i < ring.length; i += 1) {
      const hit = closestPointOnSegment(p, ring[i], ring[(i + 1) % ring.length]);
      if (!best || hit.dist2 < best.dist2) {
        best = { ringIndex, insertAt: i + 1, x: hit.x, y: hit.y };
      }
    }
  });
  return best;
}

function longestEdgeInsert(ring) {
  if (!ring || ring.length < 2) return null;
  let bestLen = -1;
  let insert = null;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const len = (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
    if (len > bestLen) {
      bestLen = len;
      insert = { insertAt: i + 1, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
  }
  return insert;
}

function applyEditedRings(area, cleanedRings, warnPct) {
  const cleanedCount = cleanedRings.reduce((sum, ring) => sum + ring.length, 0);
  const cleanedArea = cleanedRings.reduce((sum, ring) => sum + shoelaceArea(ring), 0);
  const areaDeltaPct = area.originalArea > 0 ? (Math.abs(cleanedArea - area.originalArea) / area.originalArea) * 100 : 0;
  const intersections = cleanedRings.reduce((sum, ring) => sum + countSelfIntersections(ring), 0);
  const warnings = [];
  let status = "clean";
  if (cleanedCount < 3) {
    status = "invalid";
    warnings.push("Fewer than 3 vertices.");
  } else if (cleanedArea <= 0) {
    status = "invalid";
    warnings.push("Polygon has zero area.");
  } else if (intersections > 0) {
    status = "needs-review";
    warnings.push(`Self-intersections remaining: ${intersections}.`);
  } else if (areaDeltaPct > warnPct) {
    status = "needs-review";
    warnings.push(`Area changed by ${areaDeltaPct.toFixed(1)}% (threshold ${warnPct}%).`);
  } else if (cleanedCount === area.originalCount) {
    status = "unchanged";
  }
  return { ...area, cleanedRings, cleanedCount, cleanedArea, areaDeltaPct, warnings, status };
}

export default function App() {
  const [csv1Name, setCsv1Name] = useState("");
  const [csv2Name, setCsv2Name] = useState("");
  const [pdfName, setPdfName] = useState("");
  const [error, setError] = useState("");
  const [options, setOptions] = useState(defaultCleanOptions);
  const [parsed, setParsed] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [pageDims, setPageDims] = useState({ width: 0, height: 0 });
  const [pdfCanvas, setPdfCanvas] = useState(null);
  const [scale, setScale] = useState(1);
  const [editMode, setEditMode] = useState("remove");
  const viewerRef = useRef(null);
  const csv1Ref = useRef(null);
  const csv2Ref = useRef(null);
  const mergedParsedRef = useRef(null);
  const pdfPageRef = useRef(null);
  const renderTaskRef = useRef(null);
  const areaItemRefs = useRef(new Map());
  const detailSvgRef = useRef(null);
  const dragRef = useRef(null);

  const selected = useMemo(() => {
    if (!parsed?.areas?.length) return null;
    return parsed.areas.find((a) => a.id === selectedId) || parsed.areas[0];
  }, [parsed, selectedId]);

  const allPoints = useMemo(() => {
    if (!parsed) return [];
    return parsed.areas.flatMap((area) => [
      ...(area.originalRings || []).flat(),
      ...(area.cleanedRings || []).flat(),
    ]);
  }, [parsed]);

  const contentBox = useMemo(() => bbox(allPoints), [allPoints]);

  const viewWidth = pageDims.width || Math.max(contentBox.width + 40, 400);
  const viewHeight = pageDims.height || Math.max(contentBox.height + 40, 300);
  const viewerViewBox = pdfCanvas && pageDims.width
    ? `0 0 ${pageDims.width} ${pageDims.height}`
    : `${(contentBox.minX || 0) - 20} ${(contentBox.minY || 0) - 20} ${Math.max(contentBox.width + 40, 100)} ${Math.max(contentBox.height + 40, 100)}`;

  const extentKey = useMemo(() => {
    const extent = getAreasCoordinateExtent(parsed?.areas || []);
    return extent ? `${extent.minX}:${extent.minY}:${extent.maxX}:${extent.maxY}` : "";
  }, [parsed]);

  function selectArea(id) {
    setSelectedId(id);
  }

  useEffect(() => {
    if (!viewerRef.current || !viewWidth || !viewHeight) return;
    const el = viewerRef.current;
    const next = Math.min(el.clientWidth / viewWidth, el.clientHeight / viewHeight);
    setScale(Number.isFinite(next) && next > 0 ? next : 1);
  }, [viewWidth, viewHeight, pdfCanvas, parsed]);

  async function renderAlignedPdf(page, areas) {
    if (!page) return;
    const dims = resolveFloorPlanPageDims(page, areas || []);
    const rotation = dims.source === "rotated" ? dims.rotate : 0;
    const base = page.getViewport({ scale: 1, rotation });
    const fitScale = base.width > 0 ? dims.width / base.width : 1;
    const viewport = page.getViewport({ scale: fitScale, rotation });

    if (renderTaskRef.current) {
      try {
        renderTaskRef.current.cancel();
      } catch {
        /* ignore */
      }
    }

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    const task = page.render({ canvasContext: canvas.getContext("2d"), viewport });
    renderTaskRef.current = task;
    try {
      await task.promise;
    } catch (err) {
      if (err?.name === "RenderingCancelledException") return;
      throw err;
    }
    setPdfCanvas(canvas);
    setPageDims({
      width: dims.width,
      height: dims.height,
      rotate: dims.rotate,
      source: dims.source,
    });
  }

  useEffect(() => {
    if (!pdfPageRef.current) return;
    renderAlignedPdf(pdfPageRef.current, parsed?.areas || []).catch(() => {
      setError("Failed to align PDF with area coordinates.");
    });
  }, [extentKey]);

  function recompute(nextParsed, nextOptions = options) {
    const cleaned = applyCleanup(nextParsed, nextOptions);
    setParsed(cleaned);
    if (!cleaned.areas.some((a) => a.id === selectedId)) {
      setSelectedId(cleaned.areas[0]?.id || null);
    }
  }

  function refreshFromSlots(nextOptions = options) {
    const slots = [csv1Ref.current, csv2Ref.current].filter(Boolean);
    if (!slots.length) {
      mergedParsedRef.current = null;
      setParsed(null);
      setSelectedId(null);
      return;
    }
    try {
      const merged = mergeParsedCsvs(slots);
      mergedParsedRef.current = merged;
      recompute(merged, nextOptions);
    } catch (err) {
      setError(err.message || "Failed to merge CSVs.");
    }
  }

  async function onCsvSlotChange(slot, event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const next = parseAreaCsv(await file.text());
      if (slot === 1) {
        csv1Ref.current = next;
        setCsv1Name(file.name);
      } else {
        csv2Ref.current = next;
        setCsv2Name(file.name);
      }
      setError("");
      refreshFromSlots();
    } catch (err) {
      setError(`CSV ${slot} (${file.name}): ${err.message || "Failed to parse CSV."}`);
    }
  }

  function clearCsvSlot(slot) {
    if (slot === 1) {
      csv1Ref.current = null;
      setCsv1Name("");
    } else {
      csv2Ref.current = null;
      setCsv2Name("");
    }
    refreshFromSlots();
  }

  async function onPdfChange(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const data = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data }).promise;
      const page = await pdf.getPage(1);
      pdfPageRef.current = page;
      setPdfName(file.name);
      setError("");
      await renderAlignedPdf(page, parsed?.areas || []);
    } catch (err) {
      setError(err.message || "Failed to render PDF.");
    }
  }

  function updateOption(key, value) {
    const next = { ...options, [key]: value };
    setOptions(next);
    refreshFromSlots(next);
  }

  function patchSelectedArea(updater) {
    const id = selected?.id;
    if (!id) return;
    setParsed((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        areas: prev.areas.map((area) => (area.id === id ? updater(area) : area)),
      };
    });
  }

  function deleteVertex(ringIndex, vertexIndex) {
    patchSelectedArea((area) => {
      const ring = area.cleanedRings?.[ringIndex] || [];
      if (ring.length < 4) return area;
      const cleanedRings = area.cleanedRings.map((r, i) =>
        i === ringIndex ? r.filter((_, idx) => idx !== vertexIndex) : r
      );
      return applyEditedRings(area, cleanedRings, options.areaChangeWarnPct);
    });
  }

  function insertVertex(ringIndex, insertAt, x, y) {
    patchSelectedArea((area) => {
      const cleanedRings = (area.cleanedRings || []).map((ring, i) => {
        if (i !== ringIndex) return ring;
        const next = ring.slice();
        next.splice(insertAt, 0, makePoint(x, y));
        return next;
      });
      return applyEditedRings(area, cleanedRings, options.areaChangeWarnPct);
    });
  }

  function addPointOnLongestEdge() {
    const ring = selected?.cleanedRings?.[0];
    const insert = longestEdgeInsert(ring);
    if (!insert) return;
    insertVertex(0, insert.insertAt, insert.x, insert.y);
    setEditMode("add");
  }

  function addVertexAtPoint(p) {
    const hit = findInsertOnNearestEdge(selected?.cleanedRings || [], p);
    if (!hit) return;
    insertVertex(hit.ringIndex, hit.insertAt, hit.x, hit.y);
  }

  function moveVertex(ringIndex, vertexIndex, x, y) {
    patchSelectedArea((area) => {
      const cleanedRings = (area.cleanedRings || []).map((ring, i) =>
        i === ringIndex ? ring.map((pt, idx) => (idx === vertexIndex ? makePoint(x, y) : pt)) : ring
      );
      return applyEditedRings(area, cleanedRings, options.areaChangeWarnPct);
    });
  }

  function onVertexPointerDown(event, ringIndex, vertexIndex) {
    event.preventDefault();
    event.stopPropagation();
    const svg = detailSvgRef.current;
    if (!svg) return;
    dragRef.current = { ringIndex, vertexIndex, moved: false };

    function onMove(moveEvent) {
      if (!dragRef.current) return;
      const p = svgEventPoint(svg, moveEvent);
      dragRef.current.moved = true;
      moveVertex(ringIndex, vertexIndex, p.x, p.y);
    }

    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const drag = dragRef.current;
      dragRef.current = null;
      if (!drag || drag.moved || editMode !== "remove") return;
      deleteVertex(ringIndex, vertexIndex);
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function onDetailBackgroundPointerDown(event) {
    if (editMode !== "add") return;
    const target = event.target;
    if (typeof target.closest === "function" && target.closest(".vertex, .edge-add")) return;
    const svg = detailSvgRef.current;
    if (!svg) return;
    addVertexAtPoint(svgEventPoint(svg, event));
  }

  function restoreArea(areaId) {
    if (!parsed) return;
    setParsed({
      ...parsed,
      areas: parsed.areas.map((area) => {
        if (area.id !== areaId) return area;
        return {
          ...area,
          cleanedRings: area.originalRings,
          cleanedCount: area.originalCount,
          cleanedArea: area.originalArea,
          areaDeltaPct: 0,
          status: "unchanged",
          warnings: [],
        };
      }),
    });
  }

  function handleDownloadSlot(slot) {
    const source = slot === 1 ? csv1Ref.current : csv2Ref.current;
    const name = slot === 1 ? csv1Name : csv2Name;
    if (!source || !name) return;
    const forExport = buildExportForSlot(source, parsed?.areas || [], options);
    if (!forExport) return;
    downloadTextFile(name.replace(/\.csv$/i, "") + "_cleaned.csv", exportCleanedCsv(forExport));
  }

  const reviewAreas = useMemo(
    () => (parsed?.areas || []).filter(isReviewArea),
    [parsed]
  );

  const cleanedAreas = useMemo(
    () => (parsed?.areas || []).filter(isCleanedArea),
    [parsed]
  );

  const summary = useMemo(() => {
    if (!parsed) return null;
    const removed = parsed.areas.reduce((sum, a) => sum + Math.max(0, a.originalCount - a.cleanedCount), 0);
    const tails = parsed.areas.filter((a) => (a.issues || []).some((i) => i.type === "terminal-tail" || i.type === "closing-duplicate"));
    return { removed, review: reviewAreas.length, cleaned: cleanedAreas.length, total: parsed.areas.length, tails };
  }, [parsed, reviewAreas, cleanedAreas]);

  const reviewIndex = reviewAreas.findIndex((area) => area.id === selected?.id);
  const cleanedIndex = cleanedAreas.findIndex((area) => area.id === selected?.id);

  function goToNextInList(areas, currentIndex) {
    if (!areas.length) return;
    const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % areas.length;
    selectArea(areas[nextIndex].id);
  }

  useEffect(() => {
    if (!selectedId) return;
    const el = areaItemRefs.current.get(selectedId);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedId]);

  const selectedTail = selected?.issues?.find((i) => i.type === "terminal-tail" || i.type === "closing-duplicate");

  const detailBox = bbox([
    ...(selected?.originalRings || []).flat(),
    ...(selected?.cleanedRings || []).flat(),
  ]);
  const pad = 20;
  const detailMinX = detailBox.minX - pad;
  const detailMinY = detailBox.minY - pad;
  const detailW = Math.max(detailBox.width + pad * 2, 40);
  const detailH = Math.max(detailBox.height + pad * 2, 40);

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <h1>Area Coordinate Fixer</h1>
          <p>Standalone cleaner — does not change LMS, floors, or Lutron sync.</p>
        </div>
        <div className="actions">
          <button className="btn btn-ghost" disabled={!csv1Name} onClick={() => handleDownloadSlot(1)}>
            Download cleaned CSV 1
          </button>
          <button className="btn btn-ghost" disabled={!csv2Name} onClick={() => handleDownloadSlot(2)}>
            Download cleaned CSV 2
          </button>
        </div>
      </header>

      <main className="workspace">
        <section className="panel">
          <h2>1. Load files</h2>
          <div className="panel-body">
            <div className="file-row">
              <label>CSV 1</label>
              <input type="file" accept=".csv,text/csv" onChange={(e) => onCsvSlotChange(1, e)} />
              {csv1Name ? <span className="hint">{csv1Name}{csv1Ref.current ? ` · ${slotCoordSummary(csv1Ref.current)}` : ""}</span> : null}
              {csv1Name ? (
                <button className="btn" type="button" onClick={() => clearCsvSlot(1)} style={{ marginTop: 6 }}>
                  Clear CSV 1
                </button>
              ) : null}
            </div>
            <div className="file-row">
              <label>CSV 2 (same PDF / floor)</label>
              <input type="file" accept=".csv,text/csv" onChange={(e) => onCsvSlotChange(2, e)} />
              {csv2Name ? <span className="hint">{csv2Name}{csv2Ref.current ? ` · ${slotCoordSummary(csv2Ref.current)}` : ""}</span> : null}
              {csv2Name ? (
                <button className="btn" type="button" onClick={() => clearCsvSlot(2)} style={{ marginTop: 6 }}>
                  Clear CSV 2
                </button>
              ) : null}
            </div>
            <div className="file-row">
              <label>Floor plan PDF (optional, names not required)</label>
              <input type="file" accept="application/pdf" onChange={onPdfChange} />
              {pdfName ? <span className="hint">{pdfName}</span> : null}
            </div>

            <p className="hint">
              Upload both processor CSVs for this PDF (for example leaf_areas_1 and leaf_areas_7). Coordinates can start after empty rooms. Each file has its own cleaned download.
            </p>

            <div className="slider-row">
              <label htmlFor="snap">Snap / overlap tolerance</label>
              <span>{options.snapEps.toFixed(2)}</span>
              <input
                id="snap"
                type="range"
                min="0.05"
                max="8"
                step="0.05"
                value={options.snapEps}
                onChange={(e) => updateOption("snapEps", Number(e.target.value))}
              />
            </div>
            <div className="slider-row">
              <label htmlFor="col">Collinear / extra-point tolerance</label>
              <span>{options.collinearTol.toFixed(2)}</span>
              <input
                id="col"
                type="range"
                min="0.05"
                max="20"
                step="0.05"
                value={options.collinearTol}
                onChange={(e) => updateOption("collinearTol", Number(e.target.value))}
              />
            </div>
            <div className="slider-row">
              <label htmlFor="tail">Terminal tail close (px)</label>
              <span>{(options.closeEps ?? 2).toFixed(2)}</span>
              <input
                id="tail"
                type="range"
                min="0.5"
                max="4"
                step="0.5"
                value={options.closeEps ?? 2}
                onChange={(e) => updateOption("closeEps", Number(e.target.value))}
              />
            </div>
            <div className="slider-row">
              <label htmlFor="warn">Area-change warning %</label>
              <span>{options.areaChangeWarnPct}</span>
              <input
                id="warn"
                type="range"
                min="1"
                max="25"
                step="1"
                value={options.areaChangeWarnPct}
                onChange={(e) => updateOption("areaChangeWarnPct", Number(e.target.value))}
              />
            </div>

            {error ? <div className="error">{error}</div> : null}
            {summary ? (
              <p className="hint">
                {summary.total} areas · {summary.removed} extra points removed · {summary.cleaned} cleaned · {summary.tails.length} terminal tails · {summary.review} need review
              </p>
            ) : null}
            {summary ? (
              <div className="jump-buttons">
                <button
                  className="btn btn-review"
                  type="button"
                  disabled={!reviewAreas.length}
                  onClick={() => goToNextInList(reviewAreas, reviewIndex)}
                >
                  {cycleLabel("review", reviewAreas.length, reviewIndex)}
                </button>
                <button
                  className="btn btn-cleaned"
                  type="button"
                  disabled={!cleanedAreas.length}
                  onClick={() => goToNextInList(cleanedAreas, cleanedIndex)}
                >
                  {cycleLabel("cleaned", cleanedAreas.length, cleanedIndex)}
                </button>
              </div>
            ) : null}
            {summary?.tails?.length ? (
              <div className="review-box">
                <div className="review-title">Geometry Review · {summary.tails.length} tail vertex</div>
                {summary.tails.map((area) => {
                  const issue = area.issues.find((i) => i.type === "terminal-tail" || i.type === "closing-duplicate");
                  return (
                    <button
                      key={area.id}
                      type="button"
                      className={`area-item ${selected?.id === area.id ? "active" : ""}`}
                      onClick={() => selectArea(area.id)}
                    >
                      <div className="name">
                        {area.name}
                        <span className="badge badge-needs-review">Tail</span>
                      </div>
                      <div className="meta">
                        {area.originalCount} → {area.cleanedCount} pts · last ({issue.last.x.toFixed(0)},{issue.last.y.toFixed(0)}) is {issue.distance.toFixed(2)} px from first
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : null}

            <div className="area-list">
              {(parsed?.areas || []).map((area) => (
                <button
                  key={area.id}
                  type="button"
                  className={`area-item ${selected?.id === area.id ? "active" : ""} ${isReviewArea(area) ? "needs-attention" : ""} ${isCleanedArea(area) ? "was-cleaned" : ""}`}
                  ref={(node) => {
                    if (node) areaItemRefs.current.set(area.id, node);
                    else areaItemRefs.current.delete(area.id);
                  }}
                  onClick={() => selectArea(area.id)}
                >
                  <div className="name">
                    {area.name || area.code || "Unnamed"}
                    <span className={`badge badge-${area.status}`}>{statusLabel(area.status)}</span>
                  </div>
                  <div className="meta">
                    {area.code ? `Code ${area.code} · ` : ""}
                    {area.originalCount} → {area.cleanedCount} pts · area {area.cleanedArea.toFixed(2)}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="panel">
          <h2>2. Review on floor plan</h2>
          <div className="panel-body" style={{ padding: 0, display: "flex", flexDirection: "column" }}>
            <div className="legend" style={{ padding: "10px 14px 0" }}>
              <span className="orig">Original</span>
              <span className="fix">Cleaned</span>
              {pageDims.width ? (
                <span>
                  Page: {pageDims.width.toFixed(2)}×{pageDims.height.toFixed(2)}
                  {pageDims.source ? ` · ${pageDims.source}` : ""}
                </span>
              ) : null}
            </div>
            <div className="viewer-wrap" ref={viewerRef}>
              <div
                className="viewer-stage"
                style={{ width: viewWidth, height: viewHeight, transform: `scale(${scale})` }}
              >
                {pdfCanvas ? (
                  <canvas
                    width={pdfCanvas.width}
                    height={pdfCanvas.height}
                    style={{ width: pageDims.width, height: pageDims.height, display: "block" }}
                    ref={(node) => {
                      if (node && pdfCanvas) {
                        const ctx = node.getContext("2d");
                        ctx.clearRect(0, 0, node.width, node.height);
                        ctx.drawImage(pdfCanvas, 0, 0);
                      }
                    }}
                  />
                ) : (
                  <svg width={viewWidth} height={viewHeight} viewBox={viewerViewBox}>
                    <rect x={contentBox.minX - 20} y={contentBox.minY - 20} width={viewWidth} height={viewHeight} fill="#f3f2ee" />
                  </svg>
                )}
                <svg
                  width={pageDims.width || viewWidth}
                  height={pageDims.height || viewHeight}
                  viewBox={viewerViewBox}
                >
                  {(parsed?.areas || [])
                    .filter((area) => area.id !== selected?.id)
                    .map((area) => (
                      <g key={area.id} onClick={() => selectArea(area.id)} style={{ cursor: "pointer" }}>
                        {(area.cleanedRings || []).map((ring, i) =>
                          ring.length ? (
                            <polygon
                              key={`c-${i}`}
                              points={polygonPoints(ring)}
                              fill="rgba(46,125,50,0.10)"
                              stroke="#2e7d32"
                              strokeWidth={1.2}
                            />
                          ) : null
                        )}
                      </g>
                    ))}
                  {selected ? (
                    <g key={`sel-${selected.id}`} style={{ pointerEvents: "none" }}>
                      {(selected.originalRings || []).map((ring, i) =>
                        ring.length ? (
                          <polygon
                            key={`so-${i}`}
                            points={polygonPoints(ring)}
                            fill="rgba(255,152,0,0.12)"
                            stroke="#e65100"
                            strokeDasharray="6 4"
                            strokeWidth={2}
                          />
                        ) : null
                      )}
                      {(selected.cleanedRings || []).map((ring, i) =>
                        ring.length ? (
                          <polygon
                            key={`sc-${i}`}
                            points={polygonPoints(ring)}
                            fill="rgba(255,193,7,0.45)"
                            stroke="#ff6f00"
                            strokeWidth={5}
                          />
                        ) : null
                      )}
                      {(() => {
                        const c = centroid([
                          ...(selected.cleanedRings || []).flat(),
                          ...(selected.originalRings || []).flat(),
                        ]);
                        return (
                          <text
                            x={c.x}
                            y={c.y}
                            textAnchor="middle"
                            dominantBaseline="middle"
                            fill="#bf360c"
                            fontWeight="700"
                            fontSize="22"
                          >
                            {selected.name || selected.code}
                          </text>
                        );
                      })()}
                    </g>
                  ) : null}
                </svg>
              </div>
            </div>
          </div>
        </section>

        <section className="panel">
          <h2>3. Selected area</h2>
          <div className="panel-body">
            {selected ? (
              <>
                <div className="stats">
                  <strong>{selected.name}</strong>
                  {selected.code ? ` · ${selected.code}` : ""}
                  <div>
                    Vertices {selected.originalCount} → {selected.cleanedCount}
                  </div>
                  <div>
                    Area {selected.originalArea.toFixed(2)} → {selected.cleanedArea.toFixed(2)}
                    {selected.areaDeltaPct ? ` (${selected.areaDeltaPct.toFixed(1)}% change)` : ""}
                  </div>
                </div>
                <div className="edit-modes">
                  <button
                    type="button"
                    className={`btn ${editMode === "remove" ? "btn-review" : ""}`}
                    onClick={() => setEditMode("remove")}
                  >
                    Remove points
                  </button>
                  <button
                    type="button"
                    className={`btn ${editMode === "add" ? "btn-cleaned" : ""}`}
                    onClick={() => setEditMode("add")}
                  >
                    Add points
                  </button>
                </div>
                <div className="legend">
                  <span className="orig">Before</span>
                  <span className="fix">After</span>
                  {selectedTail ? <span className="tail">Tail (red) vs first (blue)</span> : null}
                </div>
                <p className="hint">
                  {editMode === "add"
                    ? "Click an edge or a + handle to add a point. Drag a letter to move it."
                    : "Click a letter to remove that point. Drag a letter to move it."}
                </p>
                <svg
                  ref={detailSvgRef}
                  className={`detail-svg ${editMode === "add" ? "add-mode" : ""}`}
                  viewBox={`${detailMinX} ${detailMinY} ${detailW} ${detailH}`}
                  onPointerDown={onDetailBackgroundPointerDown}
                >
                  {(selected.originalRings || []).map((ring, i) => (
                    <polygon
                      key={`do-${i}`}
                      points={polygonPoints(ring)}
                      fill="rgba(198,40,40,0.12)"
                      stroke="#c62828"
                      strokeDasharray="4 3"
                      strokeWidth={Math.max(detailW, detailH) / 180}
                    />
                  ))}
                  {(selected.cleanedRings || []).map((ring, ri) => (
                    <g key={`dc-${ri}`}>
                      <polygon
                        points={polygonPoints(ring)}
                        fill="rgba(46,125,50,0.25)"
                        stroke="#2e7d32"
                        strokeWidth={Math.max(detailW, detailH) / 140}
                      />
                      {editMode === "add"
                        ? ring.map((p, i) => {
                            const n = ring[(i + 1) % ring.length];
                            const mx = (p.x + n.x) / 2;
                            const my = (p.y + n.y) / 2;
                            const r = Math.max(detailW, detailH) / 70;
                            return (
                              <g
                                key={`add-${i}`}
                                className="edge-add"
                                onPointerDown={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  insertVertex(ri, i + 1, mx, my);
                                }}
                              >
                                <circle cx={mx} cy={my} r={r} fill="#fff" stroke="#2e7d32" strokeWidth={r / 4} />
                                <text
                                  x={mx}
                                  y={my + r / 3}
                                  fontSize={r * 1.4}
                                  textAnchor="middle"
                                  fill="#2e7d32"
                                  fontWeight="700"
                                >
                                  +
                                </text>
                              </g>
                            );
                          })
                        : null}
                      {ring.map((p, i) => (
                        <g
                          key={i}
                          className="vertex"
                          onPointerDown={(event) => onVertexPointerDown(event, ri, i)}
                        >
                          <circle cx={p.x} cy={p.y} r={Math.max(detailW, detailH) / 55} fill="#1b5e20" />
                          <text
                            x={p.x}
                            y={p.y - Math.max(detailW, detailH) / 40}
                            fontSize={Math.max(detailW, detailH) / 28}
                            textAnchor="middle"
                            fill="#1b5e20"
                            fontWeight="700"
                          >
                            {vertexLabel(i)}
                          </text>
                        </g>
                      ))}
                    </g>
                  ))}
                  {selectedTail ? (
                    <g>
                      <line
                        x1={selectedTail.first.x}
                        y1={selectedTail.first.y}
                        x2={selectedTail.last.x}
                        y2={selectedTail.last.y}
                        stroke="#c62828"
                        strokeWidth={Math.max(detailW, detailH) / 90}
                      />
                      <circle cx={selectedTail.first.x} cy={selectedTail.first.y} r={Math.max(detailW, detailH) / 45} fill="#1565c0" />
                      <circle cx={selectedTail.last.x} cy={selectedTail.last.y} r={Math.max(detailW, detailH) / 45} fill="#c62828" />
                    </g>
                  ) : null}
                  {selected.cleanedRings?.[0]?.length ? (
                    <text
                      x={centroid(selected.cleanedRings[0]).x}
                      y={centroid(selected.cleanedRings[0]).y}
                      textAnchor="middle"
                      fontSize={Math.max(detailW, detailH) / 26}
                      fill="#1f2a2a"
                      style={{ pointerEvents: "none" }}
                    >
                      {selected.cleanedArea.toFixed(1)}
                    </text>
                  ) : null}
                </svg>
                {selected.warnings?.length ? (
                  <ul className="warn-list">
                    {selected.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                ) : null}
                {selected.steps?.length ? (
                  <p className="hint">
                    {selected.steps.map((s) => `${s.name}: -${s.removed}`).join(" · ")}
                  </p>
                ) : (
                  <p className="hint">No extra points found on this area.</p>
                )}
                <div className="vertex-list">
                  {(selected.cleanedRings || []).flatMap((ring, ri) =>
                    ring.map((p, i) => (
                      <div key={`${ri}-${i}`} className="vertex-row">
                        <strong>{vertexLabel(i)}</strong>
                        <span>
                          {p.x.toFixed(1)}, {p.y.toFixed(1)}
                        </span>
                        <button
                          type="button"
                          className="btn btn-tiny"
                          disabled={ring.length < 4}
                          onClick={() => deleteVertex(ri, i)}
                        >
                          Remove
                        </button>
                      </div>
                    ))
                  )}
                </div>
                <div className="edit-actions">
                  <button className="btn btn-cleaned" type="button" onClick={addPointOnLongestEdge}>
                    Add point
                  </button>
                  <button className="btn" type="button" onClick={() => restoreArea(selected.id)}>
                    Restore original vertices
                  </button>
                </div>
              </>
            ) : (
              <p className="hint">Load a CSV to inspect and clean area polygons.</p>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
