/**
 * Resolve PDF page size for overlay so CSV x/y line up with the rendered page.
 * Prefer the box that best contains the coordinate extent (crop/view size when
 * MediaBox is larger than the cropped plan used by leaf_coordinates).
 */

export function getAreasCoordinateExtent(areas = []) {
  let maxX = -Infinity;
  let maxY = -Infinity;
  let minX = Infinity;
  let minY = Infinity;
  let count = 0;

  for (const area of areas || []) {
    const rings = area?.originalRings || area?.cleanedRings || area?.rings || [];
    const coords = Array.isArray(rings[0]) ? rings.flat() : rings;
    for (const pt of coords || []) {
      if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) continue;
      count += 1;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y > maxY) maxY = pt.y;
      if (pt.x < minX) minX = pt.x;
      if (pt.y < minY) minY = pt.y;
    }
  }

  if (!count || !Number.isFinite(maxX) || !Number.isFinite(maxY)) return null;
  return { minX, minY, maxX, maxY, count };
}

export function scorePageDimsFit(extent, width, height) {
  if (!extent || !(width > 0) || !(height > 0)) return -Infinity;
  const { maxX, maxY } = extent;
  const containX = maxX <= width * 1.08;
  const containY = maxY <= height * 1.08;
  if (!containX || !containY) {
    const overflow = Math.max(0, maxX / width - 1) + Math.max(0, maxY / height - 1);
    return -1000 - overflow * 100;
  }
  const fillX = maxX / width;
  const fillY = maxY / height;
  const balance = 1 - Math.abs(fillX - fillY);
  const fill = Math.min(fillX, fillY);
  // Prefer page size close to the coordinate bounds (crop vs full media).
  const edgeX = 1 - Math.abs(fillX - 1);
  const edgeY = 1 - Math.abs(fillY - 1);
  return balance * 2 + fill + edgeX + edgeY;
}

function boxSize(box) {
  if (!box || box.length < 4) return null;
  const w = Number(box[2]) - Number(box[0]);
  const h = Number(box[3]) - Number(box[1]);
  if (!(w > 0) || !(h > 0)) return null;
  return { width: w, height: h };
}

export function resolveFloorPlanPageDims(page, areas = []) {
  const view = page?.view || [0, 0, 0, 0];
  const rotate = (((Number(page?.rotate) || 0) % 360) + 360) % 360;

  const mediaW = Number(view[2]) > 0 ? Number(view[2]) : Number(page?.getViewport?.({ scale: 1, rotation: 0 })?.width);
  const mediaH = Number(view[3]) > 0 ? Number(view[3]) : Number(page?.getViewport?.({ scale: 1, rotation: 0 })?.height);

  if (!Number.isFinite(mediaW) || !Number.isFinite(mediaH) || mediaW <= 0 || mediaH <= 0) {
    return { width: 794, height: 1123, rotate, source: "media" };
  }

  const swapped = rotate === 90 || rotate === 270;
  const candidates = [{ width: mediaW, height: mediaH, rotate, source: "media" }];

  if (swapped) {
    candidates.push({ width: mediaH, height: mediaW, rotate, source: "rotated" });
  }

  const viewSize = boxSize(view);
  if (viewSize && (Math.abs(viewSize.width - mediaW) > 0.5 || Math.abs(viewSize.height - mediaH) > 0.5)) {
    candidates.push({ ...viewSize, rotate, source: "view" });
    if (swapped) {
      candidates.push({ width: viewSize.height, height: viewSize.width, rotate, source: "view-rotated" });
    }
  }

  const crop = page?.cropBox || page?.cropbox;
  const cropSize = boxSize(crop);
  if (cropSize) {
    candidates.push({ ...cropSize, rotate, source: "crop" });
    if (swapped) {
      candidates.push({ width: cropSize.height, height: cropSize.width, rotate, source: "crop-rotated" });
    }
  }

  const extent = getAreasCoordinateExtent(areas);
  if (!extent) {
    return swapped ? candidates.find((c) => c.source === "rotated") || candidates[0] : candidates[0];
  }

  let best = candidates[0];
  let bestScore = -Infinity;
  for (const candidate of candidates) {
    const score = scorePageDimsFit(extent, candidate.width, candidate.height);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}
