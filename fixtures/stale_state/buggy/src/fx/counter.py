"""Distinct-value counter."""


class Counter:
    """Counts distinct values."""

    def __init__(self):
        self._seen = set()
        self._total = 0

    def add(self, x):
        if x in self._seen:
            return False
        self._seen.add(x)
        self._total += 1
        return True

    def total(self):
        return self._total

    def reset(self):
        self._total = 0
