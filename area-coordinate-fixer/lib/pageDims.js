/**
 * Same page-size rules as LMS resolveFloorPlanPageDims:
 * react-pdf originalWidth/Height are page.view[2] / page.view[3] (MediaBox max),
 * not crop-box width. Overlay SVG uses that box so CSV x/y line up.
 */

export function getAreasCoordinateExtent(areas = []) {
  let maxX = -Infinity;
  let maxY = -Infinity;
  let minX = Infinity;
  let minY = Infinity;
  let count = 0;

  for (const area of areas || []) {
    const rings = area?.originalRings || area?.rings || [];
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
  return balance * 2 + fill;
}

export function resolveFloorPlanPageDims(page, areas = []) {
  const view = page?.view || [0, 0, 0, 0];
  const originalWidth = Number(view[2]);
  const originalHeight = Number(view[3]);
  const rotate = (((Number(page?.rotate) || 0) % 360) + 360) % 360;

  const mediaW = originalWidth > 0 ? originalWidth : Number(page?.getViewport?.({ scale: 1, rotation: 0 })?.width);
  const mediaH = originalHeight > 0 ? originalHeight : Number(page?.getViewport?.({ scale: 1, rotation: 0 })?.height);

  if (!Number.isFinite(mediaW) || !Number.isFinite(mediaH) || mediaW <= 0 || mediaH <= 0) {
    return { width: 794, height: 1123, rotate, source: "media" };
  }

  const swapped = rotate === 90 || rotate === 270;
  const media = { width: mediaW, height: mediaH, rotate, source: "media" };
  const rotated = swapped
    ? { width: mediaH, height: mediaW, rotate, source: "rotated" }
    : media;

  const extent = getAreasCoordinateExtent(areas);
  if (!extent) {
    return swapped ? rotated : media;
  }
  if (!swapped) {
    return media;
  }

  const mediaScore = scorePageDimsFit(extent, media.width, media.height);
  const rotatedScore = scorePageDimsFit(extent, rotated.width, rotated.height);
  return rotatedScore >= mediaScore ? rotated : media;
}
