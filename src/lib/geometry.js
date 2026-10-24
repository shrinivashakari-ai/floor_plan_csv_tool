export function dist2(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export function dist(a, b) {
  return Math.sqrt(dist2(a, b));
}

export function isTerminalTail(first, last, closeEps = 2) {
  if (!isFinitePoint(first) || !isFinitePoint(last)) return false;
  return dist(first, last) <= closeEps;
}

export function isFinitePoint(p) {
  return p && Number.isFinite(p.x) && Number.isFinite(p.y);
}

export function dropInvalid(points) {
  return (points || []).filter(isFinitePoint);
}

export function isClosedRing(points, eps = 1e-6) {
  if (!points || points.length < 2) return false;
  return dist2(points[0], points[points.length - 1]) <= eps * eps;
}

export function toOpenRing(points, eps = 1e-6) {
  const copy = dropInvalid(points);
  if (isClosedRing(copy, eps) && copy.length > 1) copy.pop();
  return copy;
}

export function closeRing(points) {
  const copy = dropInvalid(points);
  if (copy.length < 1) return copy;
  if (!isClosedRing(copy, 1e-9)) {
    copy.push({ ...copy[0] });
  }
  return copy;
}

export function shoelaceArea(points) {
  const ring = toOpenRing(points);
  const n = ring.length;
  if (n < 3) return 0;
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    sum += ring[i].x * ring[j].y - ring[j].x * ring[i].y;
  }
  return Math.abs(sum) / 2;
}

export function centroid(points) {
  const ring = toOpenRing(points);
  if (!ring.length) return { x: 0, y: 0 };
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p.x;
    y += p.y;
  }
  return { x: x / ring.length, y: y / ring.length };
}

export function bbox(points) {
  const valid = dropInvalid(points);
  if (!valid.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of valid) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

export function cross(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function orientation(a, b, c, eps) {
  const v = cross(a, b, c);
  if (Math.abs(v) <= eps) return 0;
  return v > 0 ? 1 : -1;
}

function onSegment(a, b, c, eps) {
  return (
    Math.min(a.x, b.x) - eps <= c.x &&
    c.x <= Math.max(a.x, b.x) + eps &&
    Math.min(a.y, b.y) - eps <= c.y &&
    c.y <= Math.max(a.y, b.y) + eps
  );
}

export function segmentsIntersectProper(a, b, c, d, eps = 1e-9) {
  if (dist2(a, c) <= eps * eps || dist2(a, d) <= eps * eps || dist2(b, c) <= eps * eps || dist2(b, d) <= eps * eps) {
    return false;
  }
  const o1 = orientation(a, b, c, eps);
  const o2 = orientation(a, b, d, eps);
  const o3 = orientation(c, d, a, eps);
  const o4 = orientation(c, d, b, eps);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(a, b, c, eps)) return true;
  if (o2 === 0 && onSegment(a, b, d, eps)) return true;
  if (o3 === 0 && onSegment(c, d, a, eps)) return true;
  if (o4 === 0 && onSegment(c, d, b, eps)) return true;
  return false;
}

export function countSelfIntersections(points) {
  const ring = toOpenRing(points);
  const n = ring.length;
  if (n < 4) return 0;
  let count = 0;
  for (let i = 0; i < n; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    for (let j = i + 1; j < n; j += 1) {
      if (Math.abs(i - j) <= 1) continue;
      if (i === 0 && j === n - 1) continue;
      const c = ring[j];
      const d = ring[(j + 1) % n];
      if (segmentsIntersectProper(a, b, c, d)) count += 1;
    }
  }
  return count;
}

export function pathArea(points, start, end) {
  const slice = [];
  const n = points.length;
  let i = start;
  slice.push(points[i]);
  while (i !== end) {
    i = (i + 1) % n;
    slice.push(points[i]);
  }
  return shoelaceArea(slice);
}

export function vertexLabel(index) {
  if (index < 26) return String.fromCharCode(65 + index);
  const first = Math.floor(index / 26) - 1;
  const second = index % 26;
  return String.fromCharCode(65 + first) + String.fromCharCode(65 + second);
}
