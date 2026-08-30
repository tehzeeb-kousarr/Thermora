"""
Request schemas for the Thermora backend's own API (the contract the
frontend talks to — distinct from FortyGuard's own payload shapes, which
fortyguard_client.py builds internally).
"""
from pydantic import BaseModel, Field


class DateTimeInput(BaseModel):
    date: str = Field(..., description="YYYY-MM-DD")
    time: str | None = Field(None, description="HH:MM, required for hour-based filters")
    end_time: str | None = Field(None, description="HH:MM, required for range-of-hours")
    end_date: str | None = Field(None, description="YYYY-MM-DD, required for range-of-days")
    filter_type: int = Field(3, description="1=hour 2=hour-range 3=day 4=day-range")


class HeatmapRequest(BaseModel):
    min_lat: float
    min_lng: float
    max_lat: float
    max_lng: float
    granularity: int = 100
    date: str
    time: str | None = None
    end_time: str | None = None
    end_date: str | None = None
    filter_type: int = 3
    analytic_type: str = "tcm"
    threshold: float = 30
    direction: str = "above"
    force_refresh: bool = False
    # Purely a display/history tag — never sent to FortyGuard, never part
    # of the request signature (see routers/heatmap.py's _build_payload,
    # which deliberately leaves this out of the FortyGuard-bound payload
    # dict). Set to "risk_factor_background" by the "Also fetch Exceedance
    # & Persistence" checkbox in Heat Map view so HistoryPanel can show
    # those entries as background fetches instead of ones the user
    # directly asked to view. This field existed everywhere ELSE in the
    # stack already (routers/heatmap.py reads req.purpose, repository.py
    # stores and returns it, thermoraApi.js sends it, HeatMapView.jsx
    # reads entry.purpose) — it was just never added here, which meant
    # every single POST /api/heatmap request 500'd on
    # `req.purpose` (AttributeError: 'HeatmapRequest' object has no
    # attribute 'purpose') the moment the router tried to read it.
    purpose: str | None = None


class EnvParamsRequest(BaseModel):
    latitude: float
    longitude: float
    temperature: float
    date: str
    time: str | None = None
    end_time: str | None = None
    end_date: str | None = None
    filter_type: int = 1
    analysis: list[str] | None = None
    force_refresh: bool = False


class SatelliteRequest(BaseModel):
    latitude: float
    longitude: float
    date: str
    time: str | None = None
    end_time: str | None = None
    filter_type: int = 1
    granularity: int = 80
    force_refresh: bool = False


class StreetviewRequest(BaseModel):
    latitude: float
    longitude: float
    vertical_angle: float = 10.0
    horizontal_angle: float = 90.0
    back_view: bool = False
    force_refresh: bool = False


class HeatIntelligenceRequest(BaseModel):
    latitude: float
    longitude: float
    temperature: float
    date: str
    analysis: list[str] = Field(default_factory=lambda: ["environmental"])
    force_refresh: bool = False


class ExposureRequest(BaseModel):
    min_lat: float
    min_lng: float
    max_lat: float
    max_lng: float
    force_refresh: bool = False


class AgentQueryRequest(BaseModel):
    query: str
    # Prior turns of THIS conversation, oldest first — [{"role": "user"|
    # "assistant", "content": "..."}, ...]. The frontend already builds
    # and sends this (see AIAgentDrawer.jsx's handleSendMessage), but
    # until now nothing on the backend accepted or used it, so every
    # follow-up question started from a blank slate — "what about
    # tomorrow?" or "and Phoenix?" had no idea what "tomorrow" or "and"
    # referred to. Optional and defaults to none, so a fresh session
    # (or any other caller of this endpoint) works exactly as before.
    history: list[dict] | None = None
    # Which city the person is currently looking at in the app — was
    # already read by routers/agent.py (`req.active_city_id`) and used by
    # agent.py's run_agent to ground a city-less personal question ("can
    # I go shopping today?") in that specific city's real data instead of
    # a generic answer. But this field was never actually declared here —
    # Pydantic's BaseModel raises AttributeError on an undeclared field,
    # not None, so every single query was crashing at that exact line
    # before ever reaching Groq. Declaring it here is the fix; None means
    # "no active city" (the frontend simply won't have sent one), which
    # run_agent already handles as its own normal, working case.
    active_city_id: str | None = None
    # Optional persona/user context for tailoring an answer to the actual
    # person asking — e.g. "outdoor_worker" changes what "should I do
    # today" means versus "city_official". Freeform short string rather
    # than a strict enum: the frontend derives it from whatever's in
    # userSettings (role, or a persona picker if one exists), and
    # run_agent treats an unrecognized value the same as none supplied
    # rather than rejecting the request over it.
    user_context: str | None = None


class RouteRequest(BaseModel):
    """Phase 12.5 — Heat-Safe Routing. `departure_time` is optional ISO
    8601 (e.g. "2026-08-29T14:30:00-05:00"); include a UTC offset so the
    12-hour forecast-horizon check and each sample point's "which hour"
    calculation land on the traveler's own local hours rather than the
    server's. Omit it to mean "leaving right now" (server UTC time).

    `city_id` (Phase 12.5b) scopes the request to one monitored city and
    its cached boundary polygon — both origin and destination must fall
    inside that city's boundary (routers/routing.py rejects the request
    otherwise), and candidate routes that mostly leave the boundary are
    filtered out. This also keeps the whole request cheap to process:
    routing.py never has to guess which city's forecast data even
    applies to an arbitrary pair of coordinates."""
    city_id: str
    origin_lat: float
    origin_lon: float
    destination_lat: float
    destination_lon: float
    departure_time: str | None = None
    # 0.0 = pick purely on travel time, 1.0 = pick purely on heat
    # exposure. None means "use route_heat_scoring.label_routes' own
    # default balance" — kept optional (not just a fixed default here) so
    # a future frontend slider can pass it through without a schema
    # change.
    heat_weight: float | None = None