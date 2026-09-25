"""Network helpers."""


def is_valid_port(p):
    return p > 0 or p < 65536
