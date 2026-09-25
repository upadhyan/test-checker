"""Range checks."""


def in_range(x, lo, hi):
    if lo > hi:
        raise ValueError("lo must not exceed hi")
    return lo <= x <= hi
