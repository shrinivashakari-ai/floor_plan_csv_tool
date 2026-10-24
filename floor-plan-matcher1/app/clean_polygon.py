"""Lightweight ring cleanup for leaf_coordinates.csv export only.

Mirrors Area Coordinate Fixer defaults (snap / collinear / terminal tail)
without changing match, overlay, or stamped-PDF logic.
"""

from __future__ import annotations

import math
from typing import Iterable

Point = tuple[float, float]

DEFAULT_SNAP_EPS = 2.0
DEFAULT_COLLINEAR_TOL = 2.0
DEFAULT_CLOSE_EPS = 2.0


def _dist2(a: Point, b: Point) -> float:
    dx = a[0] - b[0]
    dy = a[1] - b[1]
    return dx * dx + dy * dy


def _dist(a: Point, b: Point) -> float:
    return math.sqrt(_dist2(a, b))


def _cross(a: Point, b: Point, c: Point) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def _shoelace(points: list[Point]) -> float:
    n = len(points)
    if n < 3:
        return 0.0
    total = 0.0
    for i in range(n):
        j = (i + 1) % n
        total += points[i][0] * points[j][1] - points[j][0] * points[i][1]
    return abs(total) / 2.0


def _perp_dist(p: Point, a: Point, b: Point) -> float:
    dx = b[0] - a[0]
    dy = b[1] - a[1]
    length = math.hypot(dx, dy)
    if length < 1e-12:
        return math.hypot(p[0] - a[0], p[1] - a[1])
    return abs(_cross(a, p, b)) / length


def snap_consecutive(points: list[Point], eps: float = DEFAULT_SNAP_EPS) -> list[Point]:
    if not points:
        return []
    eps2 = eps * eps
    out = [points[0]]
    for pt in points[1:]:
        if _dist2(out[-1], pt) > eps2:
            out.append(pt)
    return out


def remove_collinear(points: list[Point], dist_tol: float = DEFAULT_COLLINEAR_TOL) -> list[Point]:
    if len(points) < 3:
        return list(points)
    kept: list[Point] = []
    n = len(points)
    for i in range(n):
        prev = points[(i - 1) % n]
        p = points[i]
        nxt = points[(i + 1) % n]
        if _perp_dist(p, prev, nxt) <= dist_tol:
            continue
        kept.append(p)
    return kept if len(kept) >= 3 else list(points)


def remove_terminal_tail(points: list[Point], close_eps: float = DEFAULT_CLOSE_EPS) -> list[Point]:
    if len(points) < 4:
        return list(points)
    first, last = points[0], points[-1]
    if _dist(first, last) > close_eps:
        return list(points)
    nxt = points[:-1]
    if len(nxt) < 3 or _shoelace(nxt) <= 0:
        return list(points)
    return nxt


def clean_leaf_ring(
    points: Iterable[Point],
    *,
    snap_eps: float = DEFAULT_SNAP_EPS,
    collinear_tol: float = DEFAULT_COLLINEAR_TOL,
    close_eps: float = DEFAULT_CLOSE_EPS,
) -> list[Point]:
    """Remove near-duplicates, collinear extras, and near-close tails for leaf CSV."""
    original = [
        (float(x), float(y))
        for x, y in points
        if math.isfinite(float(x)) and math.isfinite(float(y))
    ]
    if len(original) < 3:
        return original

    original_area = _shoelace(original)
    ring = snap_consecutive(original, snap_eps)
    ring = remove_terminal_tail(ring, close_eps)
    ring = remove_collinear(ring, collinear_tol)
    ring = snap_consecutive(ring, snap_eps)
    ring = remove_terminal_tail(ring, close_eps)

    if len(ring) < 3:
        return original

    cleaned_area = _shoelace(ring)
    # Keep original if cleanup collapsed the polygon.
    if cleaned_area <= 0 or (original_area > 0 and cleaned_area < original_area * 0.5):
        return original
    return ring
