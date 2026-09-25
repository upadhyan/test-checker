"""Network helpers."""


def is_valid_port(p):
    return p > 0 and p < 65536
