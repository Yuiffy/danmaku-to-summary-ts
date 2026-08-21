"""Shared model capability rules for the Seedance queue tools."""
from __future__ import annotations


VALID_MODELS = frozenset(
    {
        "seedance2.0",
        "seedance2.0mini",
        "seedance2.0_vip",
        "seedance2.0fast_vip",
        "seedance2.5",
    }
)
VALID_RESOLUTIONS = frozenset({"480p", "720p", "1080p", "4k"})

_MODEL_RESOLUTIONS = {
    "seedance2.0": frozenset({"720p"}),
    "seedance2.0mini": frozenset({"720p"}),
    "seedance2.0_vip": frozenset({"720p", "1080p", "4k"}),
    "seedance2.0fast_vip": frozenset({"720p", "1080p", "4k"}),
    "seedance2.5": frozenset({"480p", "720p", "1080p"}),
}
_MODEL_DURATION_RANGES = {
    "seedance2.5": (4, 30),
}


def supported_resolutions(model: str) -> frozenset[str]:
    return _MODEL_RESOLUTIONS.get(model, frozenset())


def duration_bounds(model: str) -> tuple[int, int]:
    return _MODEL_DURATION_RANGES.get(model, (4, 15))
