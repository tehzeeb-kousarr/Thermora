"""
Small, dependency-free geometry helpers shared by the boundary/routing
features. No shapely/geopandas — these are plain-Python implementations
of exactly the two operations Thermora actually needs (point-in-polygon,
route-vs-boundary coverage), which keeps the backend's dependency list
(see requirements.txt) unchanged.
"""
import math


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in km. Used as a POI-list fallback distance
    (routers/places.py) when a real drive-time lookup isn't available —
    accurate straight-line, unlike comparing raw squared-degree deltas,
    which distorts east-west vs north-south distance depending on
    latitude."""
    r_km = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    h = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2
    return 2 * r_km * math.asin(min(1.0, math.sqrt(h)))


def _point_in_ring(lat: float, lon: float, ring: list[list[float]]) -> bool:
    """Standard ray-casting test. `ring` is a GeoJSON linear ring: a list
    of [lon, lat] pairs (GeoJSON is lon,lat — NOT lat,lon), first and
    last point identical. Works for both outer rings and holes; whether a
    hole should SUBTRACT is handled by the even-odd counting in
    point_in_polygon below, not here."""
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]  # lon, lat
        xj, yj = ring[j][0], ring[j][1]
        intersects = ((yi > lat) != (yj > lat)) and (
            lon < (xj - xi) * (lat - yi) / (yj - yi + 1e-15) + xi
        )
        if intersects:
            inside = not inside
        j = i
    return inside


def point_in_polygon(lat: float, lon: float, geojson: dict) -> bool:
    """True if (lat, lon) falls inside `geojson`, a GeoJSON Polygon or
    MultiPolygon (as returned by nominatim_client.fetch_city_boundary).
    Polygon rings: ring[0] is the outer boundary, ring[1:] are holes —
    even-odd rule (XOR every ring's own inside/outside result) handles
    holes correctly without special-casing them."""
    geom_type = geojson.get("type")
    if geom_type == "Polygon":
        polygons = [geojson["coordinates"]]
    elif geom_type == "MultiPolygon":
        polygons = geojson["coordinates"]
    else:
        return False

    for polygon in polygons:
        result = False
        for ring in polygon:
            if _point_in_ring(lat, lon, ring):
                result = not result
        if result:
            return True
    return False


def bbox_of_geojson(geojson: dict) -> tuple[float, float, float, float]:
    """Returns (min_lon, min_lat, max_lon, max_lat) enclosing a GeoJSON
    Polygon/MultiPolygon. Used to scope a free-text address search
    (Nominatim's viewbox) or a POI lookup (Overpass's bbox) to roughly
    the area a city's boundary covers, without fetching a second
    lat/lon range from anywhere else — the same boundary Heat-Safe
    Routing already enforces routes against is the source of truth for
    "roughly where is this city" everywhere else too."""
    geom_type = geojson.get("type")
    if geom_type == "Polygon":
        polygons = [geojson["coordinates"]]
    elif geom_type == "MultiPolygon":
        polygons = geojson["coordinates"]
    else:
        raise ValueError(f"Unsupported geometry type '{geom_type}' for bbox_of_geojson")

    lons: list[float] = []
    lats: list[float] = []
    for polygon in polygons:
        for ring in polygon:
            for lon, lat in ring:
                lons.append(lon)
                lats.append(lat)
    if not lons:
        raise ValueError("bbox_of_geojson: geometry had no coordinates")
    return min(lons), min(lats), max(lons), max(lats)


def fraction_inside_boundary(points: list[tuple[float, float]], boundary_geojson: dict) -> float:
    """Fraction (0.0-1.0) of `points` (lat, lon tuples) that fall inside
    `boundary_geojson`. Used to score a whole ROUTE's boundary
    containment (routers/routing.py) — a route counts as "within the
    city" when most, not necessarily every single one, of its sampled
    points are inside, since a route can legitimately clip a corner
    outside the strict admin boundary (a highway shoulder, a bridge
    approach) without actually leaving the area the user cares about."""
    if not points:
        return 0.0
    inside = sum(1 for lat, lon in points if point_in_polygon(lat, lon, boundary_geojson))
    return inside / len(points)