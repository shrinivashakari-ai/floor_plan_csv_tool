from app.clean_polygon import clean_leaf_ring


def test_removes_collinear_midpoints():
    dirty = [
        (0.0, 0.0),
        (5.0, 0.0),  # collinear on bottom edge
        (10.0, 0.0),
        (10.0, 6.0),
        (0.0, 6.0),
    ]
    cleaned = clean_leaf_ring(dirty, snap_eps=0.5, collinear_tol=0.5, close_eps=2)
    assert len(cleaned) == 4
    assert cleaned[0] == (0.0, 0.0)
    assert cleaned[1] == (10.0, 0.0)


def test_removes_near_duplicate_and_tail():
    dirty = [
        (0.0, 0.0),
        (0.2, 0.0),
        (10.0, 0.0),
        (10.0, 8.0),
        (0.0, 8.0),
        (0.5, 0.4),  # near-close tail
    ]
    cleaned = clean_leaf_ring(dirty, snap_eps=0.5, collinear_tol=0.5, close_eps=2)
    assert len(cleaned) == 4
    assert cleaned[0] == (0.0, 0.0)
    assert cleaned[-1][1] == 8.0


def test_keeps_real_corners():
    square = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]
    cleaned = clean_leaf_ring(square)
    assert len(cleaned) == 4
