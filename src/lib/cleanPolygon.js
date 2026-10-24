import {
  countSelfIntersections,
  cross,
  dist,
  dist2,
  dropInvalid,
  isClosedRing,
  isTerminalTail,
  pathArea,
  shoelaceArea,
} from "./geometry.js";

function clonePoint(p) {
  return { x: p.x, y: p.y, raw: p.raw };
}

function snapConsecutive(points, eps) {
  if (!points.length) return [];
  const out = [clonePoint(points[0])];
  const eps2 = eps * eps;
  for (let i = 1; i < points.length; i += 1) {
    if (dist2(out[out.length - 1], points[i]) > eps2) {
      out.push(clonePoint(points[i]));
    }
  }
  return out;
}

function unifyNearbyVertices(points, eps) {
  const out = points.map(clonePoint);
  const eps2 = eps * eps;
  for (let i = 0; i < out.length; i += 1) {
    for (let j = i + 1; j < out.length; j += 1) {
      if (dist2(out[i], out[j]) <= eps2) {
        out[j] = clonePoint(out[i]);
      }
    }
  }
  return snapConsecutive(out, eps);
}

function removeSpikes(points, eps) {
  const eps2 = eps * eps;
  let cur = points.map(clonePoint);
  let changed = true;
  let guard = 0;
  while (changed && cur.length >= 3 && guard < 40) {
    guard += 1;
    changed = false;
    const next = [];
    const n = cur.length;
    for (let i = 0; i < n; i += 1) {
      const prev = cur[(i - 1 + n) % n];
      const p = cur[i];
      const nxt = cur[(i + 1) % n];
      if (dist2(prev, nxt) <= eps2 && dist2(prev, p) > eps2) {
        changed = true;
        continue;
      }
      next.push(p);
    }
    cur = next;
  }
  return cur;
}

function perpDist(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs(cross(a, p, b)) / len;
}

function removeCollinear(points, distTol) {
  if (points.length < 3) return points;
  const next = [];
  const n = points.length;
  for (let i = 0; i < n; i += 1) {
    const prev = points[(i - 1 + n) % n];
    const p = points[i];
    const nxt = points[(i + 1) % n];
    if (perpDist(p, prev, nxt) <= distTol) continue;
    next.push(clonePoint(p));
  }
  return next.length >= 3 ? next : points.map(clonePoint);
}

function removeZeroAreaLoops(points, eps, areaTol) {
  const eps2 = eps * eps;
  let cur = points.map(clonePoint);
  let changed = true;
  let guard = 0;
  while (changed && cur.length >= 4 && guard < 40) {
    guard += 1;
    changed = false;
    const n = cur.length;
    outer: for (let i = 0; i < n; i += 1) {
      for (let j = i + 2; j < n; j += 1) {
        const wrappedAdjacent = i === 0 && j === n - 1;
        if (wrappedAdjacent) continue;
        if (dist2(cur[i], cur[j]) > eps2) continue;
        const between = j - i;
        if (between <= 1) continue;
        const loopArea = pathArea(cur, i, j);
        if (loopArea <= areaTol) {
          cur = cur.filter((_, idx) => idx <= i || idx > j);
          changed = true;
          break outer;
        }
      }
    }
  }
  return cur;
}

function douglasPeucker(points, eps) {
  if (points.length <= 2) return points.map(clonePoint);
  const eps2 = eps * eps;

  function perpDist2(p, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 <= 1e-18) return dist2(p, a);
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    return dist2(p, { x: a.x + t * dx, y: a.y + t * dy });
  }

  function simplify(pts) {
    let maxD = -1;
    let maxI = -1;
    const a = pts[0];
    const b = pts[pts.length - 1];
    for (let i = 1; i < pts.length - 1; i += 1) {
      const d = perpDist2(pts[i], a, b);
      if (d > maxD) {
        maxD = d;
        maxI = i;
      }
    }
    if (maxD > eps2 && maxI > 0) {
      const left = simplify(pts.slice(0, maxI + 1));
      const right = simplify(pts.slice(maxI));
      return left.slice(0, -1).concat(right);
    }
    return [a, b];
  }

  const open = points.map(clonePoint);
  const simplified = simplify(open);
  return simplified.length >= 3 ? simplified : open;
}

export function defaultCleanOptions() {
  return {
    snapEps: 2,
    collinearTol: 2,
    loopAreaTol: 8,
    simplifyEps: 2,
    closeEps: 2,
    areaChangeWarnPct: 8,
  };
}

/**
 * Last vertex is a drawing tail / near-close, not a real corner.
 * Only the last point may be removed.
 */
export function detectTerminalTail(points, closeEps = 2) {
  const ring = dropInvalid(points);
  if (ring.length < 4) return null;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (!isTerminalTail(first, last, closeEps)) return null;
    const d = dist(first, last);
  return {
    type: d <= 1e-9 ? "closing-duplicate" : "terminal-tail",
    index: ring.length - 1,
    first: clonePoint(first),
    last: clonePoint(last),
    distance: d,
  };
}

export function removeTerminalTail(points, closeEps = 2) {
  const issue = detectTerminalTail(points, closeEps);
  if (!issue) return { points: points.map(clonePoint), issue: null };
  const next = points.slice(0, -1).map(clonePoint);
  if (next.length < 3) return { points: points.map(clonePoint), issue: null };
  const nextArea = shoelaceArea(next);
  if (nextArea <= 0) return { points: points.map(clonePoint), issue: null };
  return { points: next, issue };
}

export function cleanRing(points, options = {}) {
  const opts = { ...defaultCleanOptions(), ...options };
  const closeEps = Number.isFinite(opts.closeEps) ? opts.closeEps : 2;
  const originalClosed = isClosedRing(points, closeEps);
  const originalArea = shoelaceArea(points);
  const originalCount = dropInvalid(points).length;
  const loopTol = Math.max(opts.loopAreaTol, opts.snapEps * opts.snapEps * 8, originalArea * 0.002);
  const simplifyEps = opts.simplifyEps > 0 ? opts.simplifyEps : opts.snapEps;
  const issues = [];

  let ring = dropInvalid(points);
  const steps = [];
  const record = (name, next) => {
    if (next.length !== ring.length) {
      steps.push({ name, removed: ring.length - next.length, remaining: next.length });
    }
    ring = next;
  };

  record("invalid", dropInvalid(ring));
  record("consecutive-duplicates", snapConsecutive(ring, opts.snapEps));
  record("stacked-cluster", unifyNearbyVertices(ring, opts.snapEps));

  const firstTail = removeTerminalTail(ring, closeEps);
  if (firstTail.issue) issues.push(firstTail.issue);
  record(firstTail.issue?.type || "terminal-tail", firstTail.points);

  record("spikes", removeSpikes(ring, opts.snapEps));
  record("zero-area-loops", removeZeroAreaLoops(ring, opts.snapEps, loopTol));
  record("collinear", removeCollinear(ring, opts.collinearTol));
  record("simplify", douglasPeucker(ring, simplifyEps));
  record("collinear-final", removeCollinear(ring, opts.collinearTol));
  record("near-duplicates-final", snapConsecutive(ring, opts.snapEps));

  const finalTail = removeTerminalTail(ring, closeEps);
  if (finalTail.issue) issues.push(finalTail.issue);
  record(finalTail.issue?.type || "terminal-tail-final", finalTail.points);

  const cleanedArea = shoelaceArea(ring);
  const intersections = countSelfIntersections(ring);
  const areaDeltaPct = originalArea > 0 ? (Math.abs(cleanedArea - originalArea) / originalArea) * 100 : 0;

  let status = "clean";
  const warnings = [];
  if (ring.length < 3) {
    status = "invalid";
    warnings.push("Fewer than 3 vertices after cleanup.");
  } else if (cleanedArea <= 0) {
    status = "invalid";
    warnings.push("Cleaned polygon has zero area.");
  } else if (intersections > 0) {
    status = "needs-review";
    warnings.push(`Self-intersections remaining: ${intersections}.`);
  } else if (areaDeltaPct > opts.areaChangeWarnPct) {
    status = "needs-review";
    warnings.push(`Area changed by ${areaDeltaPct.toFixed(1)}% (threshold ${opts.areaChangeWarnPct}%).`);
  }

  return {
    original: dropInvalid(points).map(clonePoint),
    cleaned: ring.map(clonePoint),
    originalClosed,
    originalCount,
    cleanedCount: ring.length,
    originalArea,
    cleanedArea,
    areaDeltaPct,
    intersections,
    steps,
    issues,
    status,
    warnings,
  };
}

export function cleanRings(rings, options = {}) {
  return (rings || []).map((ring) => cleanRing(ring, options));
}
