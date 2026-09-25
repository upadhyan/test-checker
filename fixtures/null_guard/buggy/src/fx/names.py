"""Name helpers."""


def normalize_name(s):
    return " ".join(part.capitalize() for part in s.strip().split())
