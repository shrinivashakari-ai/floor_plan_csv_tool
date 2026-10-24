import { cleanRing } from "./cleanPolygon.js";
import { dist } from "./geometry.js";

const COORD_RE = /^\s*(-?\d+(?:\.\d+)?)\s*[~;,]\s*(-?\d+(?:\.\d+)?)\s*$/;

export function detectDelimiter(text) {
  const sample = String(text || "")
    .split(/\r?\n/)
    .slice(0, 12)
    .join("\n");
  const scores = [
    [",", (sample.match(/,/g) || []).length],
    [";", (sample.match(/;/g) || []).length],
    ["\t", (sample.match(/\t/g) || []).length],
  ];
  scores.sort((a, b) => b[1] - a[1]);
  return scores[0][1] > 0 ? scores[0][0] : ",";
}

export function parseCsvLine(line, delimiter = ",") {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function serializeCsvField(value) {
  const s = value == null ? "" : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function formatCoord(point, decimals = 4) {
  if (point?.raw && COORD_RE.test(point.raw)) return point.raw.trim();
  const x = Number(point.x);
  const y = Number(point.y);
  return `${trimNumber(x, decimals)}~${trimNumber(y, decimals)}`;
}

function trimNumber(n, decimals) {
  if (!Number.isFinite(n)) return "0";
  const fixed = n.toFixed(decimals);
  return fixed.replace(/\.?0+$/, "") || "0";
}

function parseCoordCell(cell) {
  const match = COORD_RE.exec(String(cell || ""));
  if (!match) return null;
  return { x: Number(match[1]), y: Number(match[2]), raw: String(cell).trim() };
}

function looksLikeLutronHeader(headers) {
  const normalized = (headers || []).map((h) => String(h || "").replace(/^\uFEFF/, "").trim().toLowerCase());
  if (normalized[0] === "processor_id") return true;
  if (normalized.includes("processor_id") && (normalized.includes("name") || normalized.includes("code"))) return true;
  if (normalized[4] === "code" && normalized[5] === "name") return true;
  return false;
}

function rowHasLutronCoords(row) {
  if (!row || row.length < 7) return false;
  let numeric = 0;
  for (let c = 6; c < row.length; c += 1) {
    const cell = String(row[c] || "").trim();
    if (!cell) continue;
    if (parseCoordCell(cell) || cell === "|") return true;
    if (Number.isFinite(Number(cell))) numeric += 1;
  }
  return numeric >= 6;
}

function looksLikeLutron(rows) {
  if (!rows.length) return false;
  if (looksLikeLutronHeader(rows[0])) return true;
  const start = rows[0] && looksLikeLutronHeader(rows[0]) ? 1 : 0;
  // Second-processor exports often leave the first 40+ rooms undrawn.
  for (let r = start; r < rows.length; r += 1) {
    if (rowHasLutronCoords(rows[r])) return true;
  }
  return false;
}

function headerIndex(headers, aliases) {
  const normalized = headers.map((h) => String(h || "").trim().toLowerCase());
  for (const alias of aliases) {
    const idx = normalized.indexOf(alias);
    if (idx >= 0) return idx;
  }
  return -1;
}

function splitRingsFromCells(cells) {
  const rings = [[]];
  let pendingX = null;
  for (const cell of cells) {
    const trimmed = String(cell || "").trim();
    if (!trimmed) continue;
    if (trimmed === "|") {
      if (rings[rings.length - 1].length) rings.push([]);
      pendingX = null;
      continue;
    }
    const pt = parseCoordCell(trimmed);
    if (pt) {
      rings[rings.length - 1].push(pt);
      pendingX = null;
      continue;
    }
    const n = Number(trimmed);
    if (Number.isFinite(n)) {
      if (pendingX == null) pendingX = n;
      else {
        rings[rings.length - 1].push({ x: pendingX, y: n });
        pendingX = null;
      }
    }
  }
  return rings.filter((ring) => ring.length > 0);
}

function parseLutron(rows) {
  const header = rows[0] || [];
  const areas = [];
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || row.every((cell) => !String(cell || "").trim())) continue;
    const rings = splitRingsFromCells(row.slice(6));
    areas.push({
      id: `row-${i}`,
      rowIndex: i,
      processorId: String(row[0] || "").trim(),
      rootArea: String(row[1] || "").trim(),
      rootSubarea: String(row[2] || "").trim(),
      rootSubSubarea: String(row[3] || "").trim(),
      code: String(row[4] || "").trim(),
      name: String(row[5] || "").trim() || `Area ${i}`,
      rings,
      extra: {},
    });
  }
  return {
    format: "lutron",
    header,
    areas,
  };
}

function parseLongFormat(rows) {
  const header = rows[0] || [];
  const nameIdx = headerIndex(header, ["name", "area_name", "area", "room", "room_name"]);
  const xIdx = headerIndex(header, ["x", "coord_x", "longitude"]);
  const yIdx = headerIndex(header, ["y", "coord_y", "latitude"]);
  const codeIdx = headerIndex(header, ["code", "area_code"]);
  if (xIdx < 0 || yIdx < 0) {
    const preview = (header || [])
      .slice(0, 6)
      .map((cell) => String(cell || "").replace(/^\uFEFF/, "").trim())
      .filter(Boolean)
      .join(", ");
    throw new Error(
      `Unrecognized CSV. First columns: ${preview || "(empty)"}. Expected Lutron leaf-areas (processor_id…name, then x~y — coords may start after empty rooms) or columns name,x,y.`
    );
  }

  const groups = new Map();
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    const x = Number(row[xIdx]);
    const y = Number(row[yIdx]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const name = nameIdx >= 0 ? String(row[nameIdx] || "").trim() : "";
    const code = codeIdx >= 0 ? String(row[codeIdx] || "").trim() : "";
    const key = `${code}||${name || `row-group`}`;
    if (!groups.has(key)) {
      groups.set(key, {
        id: `group-${groups.size + 1}`,
        rowIndex: i,
        processorId: "",
        rootArea: "",
        rootSubarea: "",
        rootSubSubarea: "",
        code,
        name: name || `Area ${groups.size + 1}`,
        rings: [[]],
      });
    }
    groups.get(key).rings[0].push({ x, y });
  }

  return {
    format: "long",
    header,
    areas: Array.from(groups.values()),
  };
}

export function parseAreaCsv(text) {
  const raw = String(text || "").replace(/^\uFEFF/, "");
  const delimiter = detectDelimiter(raw);
  const lines = raw.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) {
    throw new Error("CSV is empty or missing data rows.");
  }
  const rows = lines.map((line) => parseCsvLine(line, delimiter));
  let start = 0;
  while (start < rows.length - 1 && !looksLikeLutronHeader(rows[start]) && !rowHasLutronCoords(rows[start + 1]) && !rowHasLutronCoords(rows[start])) {
    const h = rows[start].map((c) => String(c || "").trim().toLowerCase());
    if (h.includes("x") && h.includes("y")) break;
    start += 1;
    if (start > 8) {
      start = 0;
      break;
    }
  }
  const sliced = rows.slice(start);
  if (looksLikeLutron(sliced)) return parseLutron(sliced);
  return parseLongFormat(sliced);
}

export function areaMergeKey(area) {
  // Same floor / PDF: two processors share code+name; only one row has vertices.
  return `${area.code || ""}||${area.name || ""}`;
}

function vertexCount(area) {
  return (area.rings || []).reduce((sum, ring) => sum + (ring?.length || 0), 0);
}

/** Merge 1+ parsed CSVs for the same floor PDF. Duplicate processor+code+name keeps the row with more vertices. */
export function mergeParsedCsvs(parsedList) {
  const list = (parsedList || []).filter((p) => p?.areas?.length);
  if (!list.length) {
    throw new Error("No CSV data to merge.");
  }
  const lutron = list.find((p) => p.format === "lutron") || list[0];
  const byKey = new Map();
  for (const parsed of list) {
    for (const area of parsed.areas) {
      if (vertexCount(area) < 1) continue;
      const key = areaMergeKey(area);
      const next = { ...area };
      const existing = byKey.get(key);
      if (!existing || vertexCount(next) > vertexCount(existing)) {
        byKey.set(key, next);
      }
    }
  }
  if (!byKey.size) {
    throw new Error("CSV has area names but no coordinates (x~y) yet. Use the processor file that has drawn polygons.");
  }
  return {
    format: lutron.format,
    header: lutron.header,
    areas: Array.from(byKey.values()).map((area, i) => ({
      ...area,
      id: `area-${area.processorId || "p"}-${area.code || "c"}-${i}`,
    })),
  };
}

export function applyCleanup(parsed, options) {
  return {
    ...parsed,
    areas: parsed.areas.map((area) => {
      const ringResults = (area.rings || []).map((ring) => cleanRing(ring, options));
      const originalCount = ringResults.reduce((sum, r) => sum + r.originalCount, 0);
      const cleanedCount = ringResults.reduce((sum, r) => sum + r.cleanedCount, 0);
      const originalArea = ringResults.reduce((sum, r) => sum + r.originalArea, 0);
      const cleanedArea = ringResults.reduce((sum, r) => sum + r.cleanedArea, 0);
      const warnings = ringResults.flatMap((r) => r.warnings);
      const steps = ringResults.flatMap((r) => r.steps);
      const issues = ringResults.flatMap((r) => r.issues || []);
      let status = "clean";
      if (ringResults.some((r) => r.status === "invalid") || cleanedCount < 3) status = "invalid";
      else if (ringResults.some((r) => r.status === "needs-review") || warnings.length) status = "needs-review";
      else if (originalCount === cleanedCount) status = "unchanged";

      return {
        ...area,
        ringResults,
        originalRings: ringResults.map((r) => r.original),
        cleanedRings: ringResults.map((r) => r.cleaned),
        originalCount,
        cleanedCount,
        originalArea,
        cleanedArea,
        areaDeltaPct: originalArea > 0 ? (Math.abs(cleanedArea - originalArea) / originalArea) * 100 : 0,
        steps,
        issues,
        warnings,
        status,
      };
    }),
  };
}

function dedupeExportRing(ring) {
  if (!ring?.length) return [];
  const pts = [];
  for (const p of ring) {
    const prev = pts[pts.length - 1];
    if (prev && prev.x === p.x && prev.y === p.y) continue;
    pts.push(p);
  }
  if (pts.length >= 4 && dist(pts[0], pts[pts.length - 1]) <= 2) {
    pts.pop();
  }
  return pts;
}

function ringsToLutronCells(rings) {
  const cells = [];
  rings.forEach((ring, index) => {
    if (index > 0) cells.push("|");
    for (const p of dedupeExportRing(ring)) cells.push(formatCoord(p));
  });
  return cells;
}

/**
 * Build a downloadable slot CSV: auto-cleanup, then overlay any manual
 * vertex edits from the merged UI state (add / remove / drag).
 */
export function buildExportForSlot(source, editedAreas, options) {
  if (!source) return null;
  const cleaned = applyCleanup(source, options);
  const editMap = new Map();
  for (const area of editedAreas || []) {
    editMap.set(areaMergeKey(area), area);
  }
  return {
    ...cleaned,
    areas: cleaned.areas.map((area) => {
      const edited = editMap.get(areaMergeKey(area));
      if (!edited?.cleanedRings) return area;
      const sourceHadCoords = (area.rings || []).some((ring) => ring?.length);
      if (!sourceHadCoords) return area;
      return {
        ...area,
        cleanedRings: edited.cleanedRings,
        cleanedCount: edited.cleanedCount ?? edited.cleanedRings.reduce((sum, ring) => sum + ring.length, 0),
        cleanedArea: edited.cleanedArea,
        areaDeltaPct: edited.areaDeltaPct,
        status: edited.status,
        warnings: edited.warnings || [],
      };
    }),
  };
}

export function exportCleanedCsv(parsed) {
  if (!parsed?.areas) return "";
  if (parsed.format === "long") {
    const header = parsed.header?.length ? parsed.header : ["name", "x", "y"];
    const nameIdx = header.findIndex((h) => /name|area/i.test(String(h)));
    const xIdx = header.findIndex((h) => String(h).toLowerCase() === "x");
    const yIdx = header.findIndex((h) => String(h).toLowerCase() === "y");
    const lines = [header.map(serializeCsvField).join(",")];
    for (const area of parsed.areas) {
      for (const ring of area.cleanedRings || []) {
        for (const p of dedupeExportRing(ring)) {
          const row = new Array(header.length).fill("");
          if (nameIdx >= 0) row[nameIdx] = area.name;
          if (xIdx >= 0) row[xIdx] = trimNumber(p.x, 4);
          if (yIdx >= 0) row[yIdx] = trimNumber(p.y, 4);
          if (nameIdx < 0 || xIdx < 0 || yIdx < 0) {
            lines.push([area.name, trimNumber(p.x, 4), trimNumber(p.y, 4)].map(serializeCsvField).join(","));
          } else {
            lines.push(row.map(serializeCsvField).join(","));
          }
        }
      }
    }
    return `${lines.join("\n")}\n`;
  }

  const maxCoords = parsed.areas.reduce((max, area) => {
    const cells = ringsToLutronCells(area.cleanedRings || []);
    return Math.max(max, cells.length);
  }, 0);

  const header = [...(parsed.header || []).slice(0, 6)];
  while (header.length < 6 + maxCoords) header.push("");
  const lines = [header.map(serializeCsvField).join(",")];

  for (const area of parsed.areas) {
    const coordCells = ringsToLutronCells(area.cleanedRings || []);
    const row = [
      area.processorId,
      area.rootArea,
      area.rootSubarea,
      area.rootSubSubarea,
      area.code,
      area.name,
      ...coordCells,
    ];
    lines.push(row.map(serializeCsvField).join(","));
  }
  return `${lines.join("\n")}\n`;
}

export function downloadTextFile(filename, text, mime = "text/csv;charset=utf-8") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
