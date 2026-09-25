"""Name helpers."""


def normalize_name(s):
    if s is None or not s.strip():
        raise ValueError("name must be a non-empty string")
    return " ".join(part.capitalize() for part in s.strip().split())
