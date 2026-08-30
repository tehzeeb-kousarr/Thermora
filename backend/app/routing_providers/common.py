"""Shared validation for routing provider modules — see this package's
__init__.py docstring for the normalized route shape every provider
must produce."""


def normalize_route(provider: str, geometry: list[tuple[float, float]],
                     distance_m: float, duration_s: float) -> dict | None:
    """A route with fewer than 2 points, or a non-positive duration/
    distance, isn't something route_heat_scoring.py could sample or
    score — dropped here rather than passed downstream as a dict later
    code has to separately remember to re-validate."""
    if not geometry or len(geometry) < 2:
        return None
    if not duration_s or duration_s <= 0:
        return None
    if not distance_m or distance_m <= 0:
        return None
    return {
        "provider": provider,
        "geometry": geometry,
        "distance_m": float(distance_m),
        "duration_s": float(duration_s),
    }
