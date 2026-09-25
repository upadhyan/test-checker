"""Small arithmetic helpers."""


def sum_to(n):
    if n < 0:
        raise ValueError("n must be non-negative")
    total = 0
    for i in range(n):
        total += i
    return total
