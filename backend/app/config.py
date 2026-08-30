"""
Centralized configuration loaded from environment variables (.env in dev).
Nothing sensitive is ever hardcoded — the FortyGuard API key and DB
credentials must be supplied via the environment.
"""
import os

from dotenv import load_dotenv

load_dotenv()


def _require(name: str, default: str | None = None) -> str:
    value = os.getenv(name, default)
    if value is None:
        raise RuntimeError(
            f"Missing required environment variable: {name}. "
            f"Copy backend/.env.example to backend/.env and fill it in."
        )
    return value


class Settings:
    # FortyGuard
    FORTYGUARD_API_KEY: str = _require("FORTYGUARD_API_KEY")
    FORTYGUARD_BASE_URL: str = os.getenv(
        "FORTYGUARD_BASE_URL", "https://api.fortyguard.com/v1"
    )

    # Postgres
    POSTGRES_HOST: str = os.getenv("POSTGRES_HOST", "localhost")
    POSTGRES_PORT: int = int(os.getenv("POSTGRES_PORT", "5432"))
    POSTGRES_USER: str = os.getenv("POSTGRES_USER", "postgres")
    POSTGRES_PASSWORD: str = os.getenv("POSTGRES_PASSWORD", "postgres")
    POSTGRES_DB: str = os.getenv("POSTGRES_DB", "thermora")

    # Logging
    LOG_LEVEL: str = os.getenv("LOG_LEVEL", "DEBUG")

    # CORS
    FRONTEND_ORIGIN: str = os.getenv("FRONTEND_ORIGIN", "http://localhost:5173")

    # Polling behavior for async FortyGuard activities
    POLL_INTERVAL_SECONDS: float = float(os.getenv("POLL_INTERVAL_SECONDS", "5"))
    POLL_MAX_ATTEMPTS: int = int(os.getenv("POLL_MAX_ATTEMPTS", "120"))  # ~10 min ceiling

    # Transient-error backoff (429 rate limit / 500 server error) — separate
    # from POLL_MAX_ATTEMPTS, which is about "still Processing", not errors.
    # Without this, a single 429 (e.g. the scheduler working through several
    # cities back to back) killed that request outright instead of backing
    # off and retrying, which is what a rate-limit response is asking for.
    RETRY_MAX_ATTEMPTS: int = int(os.getenv("RETRY_MAX_ATTEMPTS", "5"))
    RETRY_BASE_DELAY_SECONDS: float = float(os.getenv("RETRY_BASE_DELAY_SECONDS", "2"))
    RETRY_MAX_DELAY_SECONDS: float = float(os.getenv("RETRY_MAX_DELAY_SECONDS", "30"))

    # Background scheduler — OFF by default now. It used to eagerly
    # pre-warm every "monitored" city on a timer regardless of whether
    # anyone was viewing them, which meant the app was continuously
    # burning FortyGuard requests on cities nobody had opened. City
    # summaries are now fetched lazily, on-demand, only for the specific
    # city a user actually selects (see CITY_SUMMARY_TTL_MINUTES and
    # routers/cities.py). This flag remains only for a deployment that
    # explicitly wants the old always-on eager-refresh behavior back.
    ENABLE_SCHEDULER: bool = os.getenv("ENABLE_SCHEDULER", "false").lower() == "true"
    SCHEDULER_INTERVAL_MINUTES: float = float(os.getenv("SCHEDULER_INTERVAL_MINUTES", "30"))
    SCHEDULER_CITY_STAGGER_SECONDS: float = float(os.getenv("SCHEDULER_CITY_STAGGER_SECONDS", "3"))
    # How long a lazily-fetched city summary stays good before the next
    # visit to that city triggers a fresh live fetch. Nothing is fetched
    # for a city nobody has opened — this bounds re-fetching on repeat
    # views, it isn't a background job.
    CITY_SUMMARY_TTL_MINUTES: float = float(os.getenv("CITY_SUMMARY_TTL_MINUTES", "30"))
    # Deliberately small/coarse — this is a cheap "what's the current
    # temperature roughly here" read, not the fine-grained tile grid the
    # Heat Map view fetches when a user actively drills into one city.
    # Kept wide enough to reliably clear a handful of tiles at
    # SUMMARY_GRANULARITY even at 100m — too tight a box risks FortyGuard
    # legitimately returning zero cells for an area smaller than one tile.
    SUMMARY_HALF_WIDTH_DEG: float = float(os.getenv("SUMMARY_HALF_WIDTH_DEG", "0.006"))
    SUMMARY_GRANULARITY: int = int(os.getenv("SUMMARY_GRANULARITY", "100"))

    # --- Phase 6: OSM (Overpass API) exposure points ---
    # "Who/what is exposed" — schools, hospitals/healthcare, plus a coarse
    # building/residential/road density proxy, for a given AOI. This data
    # barely changes over time, so it's cached far longer than heat data.
    OVERPASS_BASE_URL: str = os.getenv("OVERPASS_BASE_URL", "https://overpass-api.de/api/interpreter")
    # Public Overpass mirrors, tried in order if the primary is overloaded
    # or returns a non-200 (e.g. 406/429/504). The primary is included as
    # the first entry so a single list drives both "normal" and "fallback"
    # behavior. Ordered by observed reliability — openstreetmap.ru moved
    # last since it's been seen to fail outright (connection refused) more
    # often than the others; openstreetmap.fr added as a generally solid
    # extra option most default configs were missing.
    OVERPASS_FALLBACK_URLS: list[str] = [
        u.strip()
        for u in os.getenv(
            "OVERPASS_FALLBACK_URLS",
            "https://overpass.openstreetmap.fr/api/interpreter,"
            "https://overpass.kumi.systems/api/interpreter,"
            "https://overpass.openstreetmap.ru/api/interpreter",
        ).split(",")
        if u.strip()
    ]
    OVERPASS_TIMEOUT_SECONDS: float = float(os.getenv("OVERPASS_TIMEOUT_SECONDS", "30"))
    # Overpass's Apache front-ends (overpass-api.de and most mirrors) return
    # 406 Not Acceptable for requests without a real, identifying User-Agent
    # — their usage policy asks for contact info (same spirit as
    # NWS_USER_AGENT below). Set this in .env for production use; the
    # default below is still a valid, non-empty, identifiable string.
    OVERPASS_USER_AGENT: str = os.getenv(
        "OVERPASS_USER_AGENT", "ThermoraHeatIntelligence/1.0 (contact: set OVERPASS_USER_AGENT in .env)"
    )
    EXPOSURE_CACHE_DAYS: float = float(os.getenv("EXPOSURE_CACHE_DAYS", "30"))

    # Geoapify Places API — alternative provider for the points/density
    # portion of Phase 6 exposure data. Overpass is free but a shared,
    # unauthenticated public service: it can be slow, malformed queries
    # return opaque 400s, and some mirrors are flatly unreachable depending
    # on network path (all confirmed in real testing, not hypothetical).
    # Geoapify is a normal authenticated REST API — one HTTP GET per
    # category, no query language — free tier is 3,000 requests/day.
    # Get a key at https://myprojects.geoapify.com (free signup).
    # Leave blank to skip Geoapify entirely and use Overpass only (the
    # original Phase 6 behavior).
    GEOAPIFY_API_KEY: str = os.getenv("GEOAPIFY_API_KEY", "")
    GEOAPIFY_BASE_URL: str = os.getenv("GEOAPIFY_BASE_URL", "https://api.geoapify.com/v2/places")
    GEOAPIFY_TIMEOUT_SECONDS: float = float(os.getenv("GEOAPIFY_TIMEOUT_SECONDS", "20"))

    # --- Phase 7: NWS/NOAA active alerts ---
    # "Is this an officially recognized event" — the VERIFY step. NWS's API
    # requires a descriptive User-Agent identifying the calling application
    # (their docs ask for an app name + contact); set NWS_USER_AGENT in .env
    # to your own contact info before deploying this for real.
    NWS_BASE_URL: str = os.getenv("NWS_BASE_URL", "https://api.weather.gov")
    NWS_USER_AGENT: str = os.getenv("NWS_USER_AGENT", "Thermora Heat Intelligence (set NWS_USER_AGENT in .env)")
    ALERTS_CACHE_MINUTES: float = float(os.getenv("ALERTS_CACHE_MINUTES", "10"))
    # NWS documents rate limiting; a bounded retry with backoff on 429/5xx
    # is cheap parity with what fortyguard_client.py already does — this
    # previously had none at all.
    NWS_RETRY_MAX_ATTEMPTS: int = int(os.getenv("NWS_RETRY_MAX_ATTEMPTS", "3"))
    NWS_RETRY_BASE_DELAY_SECONDS: float = float(os.getenv("NWS_RETRY_BASE_DELAY_SECONDS", "1.5"))
    NWS_RETRY_MAX_DELAY_SECONDS: float = float(os.getenv("NWS_RETRY_MAX_DELAY_SECONDS", "10"))

    # --- Phase 11: Heat Story narrative (Gemini) ---
    # The one place in Thermora an LLM actually writes prose — everything
    # upstream (Risk Score, Impact Score, Emergency Mode) is deterministic.
    # Deliberately NOT required via _require(): the rest of the backend
    # (heatmap/env-params/exposure/alerts/scores/Emergency Mode) must keep
    # working with no key set at all — Heat Story's own narrate endpoint is
    # the only thing that degrades (see gemini_client.py), not the whole app.
    # Get a key at https://aistudio.google.com/apikey.
    # NOTE: routers/heat_story.py currently imports groq_client, not this —
    # see the GROQ_* block below. gemini_client.py is left in place, fully
    # working, in case of a switch back; it just isn't wired into the
    # router right now.
    GEMINI_API_KEY: str = os.getenv("GEMINI_API_KEY", "")
    GEMINI_MODEL: str = os.getenv("GEMINI_MODEL", "gemini-flash-latest")
    GEMINI_BASE_URL: str = os.getenv(
        "GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta"
    )
    GEMINI_TIMEOUT_SECONDS: float = float(os.getenv("GEMINI_TIMEOUT_SECONDS", "45"))

    # --- Phase 11: Heat Story narrative (Groq) ---
    # Same role as the Gemini block above, now the one actually wired into
    # routers/heat_story.py. Groq's API is OpenAI-compatible (POST
    # /openai/v1/chat/completions, messages: [...], response under
    # choices[0].message.content) — see groq_client.py. Get a key at
    # https://console.groq.com/keys. Also deliberately NOT required via
    # _require() — same reasoning as GEMINI_API_KEY above.
    GROQ_API_KEY: str = os.getenv("GROQ_API_KEY", "")
    # Optional pool of MULTIPLE Groq API keys, comma-separated — see
    # agent.py's _select_groq_key. Only useful if the keys come from
    # genuinely separate Groq accounts/orgs: Groq's rate limits are
    # scoped to the ORGANIZATION, not the individual key, so several
    # keys from the SAME account/org all draw from one shared budget and
    # failing over between them would not help at all. Keys from
    # different orgs each have their own independent budget, so this
    # gives real aggregate throughput. Falls back to GROQ_API_KEY alone
    # (unchanged single-key behavior) when unset.
    GROQ_API_KEYS: str = os.getenv("GROQ_API_KEYS", "")
    # llama-3.3-70b-versatile was decommissioned by Groq (announced
    # 2026-06-17, shut down 2026-08); openai/gpt-oss-120b is Groq's own
    # recommended replacement for it — same OpenAI-compatible chat
    # completions shape, no other code changes needed. If you're on an
    # older .env with GROQ_MODEL=llama-3.3-70b-versatile still set,
    # you'll need to update it there too — this default only applies when
    # the env var is unset.
    GROQ_MODEL: str = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")
    GROQ_BASE_URL: str = os.getenv("GROQ_BASE_URL", "https://api.groq.com/openai/v1")
    GROQ_TIMEOUT_SECONDS: float = float(os.getenv("GROQ_TIMEOUT_SECONDS", "45"))
    # Same shape as NWS_RETRY_* above — 429/5xx (Groq's real rate limits
    # and exactly the kind of transient 503 that prompted this switch) are
    # worth a short backoff-and-retry; 4xx isn't, since a malformed
    # request fails identically every time.
    GROQ_RETRY_MAX_ATTEMPTS: int = int(os.getenv("GROQ_RETRY_MAX_ATTEMPTS", "3"))
    GROQ_RETRY_BASE_DELAY_SECONDS: float = float(os.getenv("GROQ_RETRY_BASE_DELAY_SECONDS", "1.5"))
    GROQ_RETRY_MAX_DELAY_SECONDS: float = float(os.getenv("GROQ_RETRY_MAX_DELAY_SECONDS", "60"))
    # How long an identical agent query (same text, same active city) is
    # served from cache instead of re-running the whole investigation —
    # see agent.py's response cache. Short on purpose: this is for
    # "asked twice in the same breath" (a demo, a double-click, a retry
    # after a transient error), not a general-purpose cache — the
    # underlying heat data genuinely changes hour to hour.
    AGENT_RESPONSE_CACHE_TTL_SECONDS: float = float(os.getenv("AGENT_RESPONSE_CACHE_TTL_SECONDS", "90"))


    # --- Phase 12.5: Heat-Safe Routing ---
    # FortyGuard has no routing/directions endpoint (confirmed against the
    # 5 endpoints in the roadmap) — routes (the actual road geometry +
    # distance/duration) come from free third-party routing providers.
    # FortyGuard stays the ONLY source of truth for heat itself: once a
    # provider hands back a candidate route, every point along it is
    # scored using the exact same tcm-heatmap/forecast machinery Heat
    # Story already uses (repository.get_heatmap(..., persist=False)),
    # never a second heat data source. Mixing heat providers would make
    # "23% less heat exposure" a comparison between two different models'
    # opinions rather than one consistent measurement.
    #
    # Two providers need no API key at all (public demo/community
    # servers — fine for a hackathon, NOT for real production traffic,
    # see their own usage policies): OSRM's public demo server and
    # FOSSGIS's public Valhalla server. Two more are free-tier
    # authenticated REST APIs (real signup, no card): OpenRouteService
    # (2,000 req/day) and GraphHopper (500 req/day). All four are queried
    # in parallel per request (see route_merge.py) and a provider that's
    # down/slow/unconfigured just quietly drops out of the result set —
    # no single provider is a hard dependency for routing to work at all.
    OSRM_BASE_URL: str = os.getenv("OSRM_BASE_URL", "https://router.project-osrm.org")
    VALHALLA_BASE_URL: str = os.getenv("VALHALLA_BASE_URL", "https://valhalla1.openstreetmap.de")
    # Free signup at https://openrouteservice.org/dev/#/signup. Leave
    # blank to skip this provider entirely.
    ORS_API_KEY: str = os.getenv("ORS_API_KEY", "")
    ORS_BASE_URL: str = os.getenv("ORS_BASE_URL", "https://api.openrouteservice.org")
    # Free signup at https://www.graphhopper.com/dashboard/#/register.
    # Leave blank to skip this provider entirely.
    GRAPHHOPPER_API_KEY: str = os.getenv("GRAPHHOPPER_API_KEY", "")
    GRAPHHOPPER_BASE_URL: str = os.getenv("GRAPHHOPPER_BASE_URL", "https://graphhopper.com/api/1")
    ROUTING_TIMEOUT_SECONDS: float = float(os.getenv("ROUTING_TIMEOUT_SECONDS", "12"))

    # Two candidate routes are treated as "the same route" (deduped down
    # to one) when this fraction of one route's sampled points each land
    # within ROUTE_DEDUPE_DISTANCE_DEG of the other route's path — cheap
    # planar-distance overlap check, same spirit as locations.nearest_city,
    # good enough at street/road scale without a real Fréchet-distance
    # implementation. Prevents showing a user 4 near-identical "Fastest"
    # options just because 3 different providers happened to compute
    # basically the same road path.
    ROUTE_DEDUPE_DISTANCE_DEG: float = float(os.getenv("ROUTE_DEDUPE_DISTANCE_DEG", "0.003"))  # ~300m
    ROUTE_DEDUPE_OVERLAP_FRACTION: float = float(os.getenv("ROUTE_DEDUPE_OVERLAP_FRACTION", "0.8"))

    # How many points along a single route get their own heat reading.
    # More points = more accurate exposure estimate but more FortyGuard
    # calls per route; capped low deliberately since several candidate
    # routes are scored per single user request. Points are spaced by
    # travel TIME (see route_heat_scoring.py), not raw distance, so a
    # slow congested segment still gets sampled proportionally to how
    # long a traveler is actually exposed to it.
    ROUTE_MAX_SAMPLE_POINTS: int = int(os.getenv("ROUTE_MAX_SAMPLE_POINTS", "8"))
    ROUTE_MIN_SAMPLE_INTERVAL_MINUTES: float = float(os.getenv("ROUTE_MIN_SAMPLE_INTERVAL_MINUTES", "10"))
    # Same forecast ceiling as Heat Story's FORECAST_HORIZON_HOURS (see
    # heat_story.py) — FortyGuard's forecast product simply isn't valid
    # further out than this, full stop, regardless of which feature is
    # asking. Any route sample point whose estimated arrival time falls
    # beyond this window from "now" gets no FortyGuard call at all and is
    # reported as "no forecast available" rather than silently guessed.
    ROUTE_FORECAST_HORIZON_HOURS: int = int(os.getenv("ROUTE_FORECAST_HORIZON_HOURS", "12"))
    # Small AOI box built around each individual sample point (as opposed
    # to a whole city's box) — deliberately tighter than
    # SUMMARY_HALF_WIDTH_DEG since this only ever needs to resolve the
    # temperature immediately around one road point, not a cross-city
    # summary. Also rounded to a coarse grid before being used (see
    # route_heat_scoring._grid_round) so that nearby sample points from
    # different candidate routes collapse onto the same FortyGuard
    # request and hit repository's existing signature-based cache instead
    # of each paying for their own near-duplicate fetch.
    ROUTE_POINT_HALF_WIDTH_DEG: float = float(os.getenv("ROUTE_POINT_HALF_WIDTH_DEG", "0.004"))
    ROUTE_POINT_GRID_DEG: float = float(os.getenv("ROUTE_POINT_GRID_DEG", "0.01"))  # ~1km

    # --- Phase 12.5b: city boundary enforcement ---
    # Nominatim (OSM's free search/geocode service) is what actually
    # resolves a city name to its administrative boundary polygon — see
    # nominatim_client.py. No API key; usage policy just asks for a real
    # User-Agent and caps at ~1 req/sec, which is irrelevant here since
    # this is only ever called once per city then cached (see
    # BOUNDARY_CACHE_DAYS) — never on the hot path of an actual route
    # request.
    NOMINATIM_BASE_URL: str = os.getenv("NOMINATIM_BASE_URL", "https://nominatim.openstreetmap.org")
    NOMINATIM_USER_AGENT: str = os.getenv(
        "NOMINATIM_USER_AGENT", "ThermoraHeatIntelligence/1.0 (contact: set NOMINATIM_USER_AGENT in .env)"
    )
    NOMINATIM_TIMEOUT_SECONDS: float = float(os.getenv("NOMINATIM_TIMEOUT_SECONDS", "20"))
    # City boundaries essentially never change — cached far longer than
    # heat/exposure data.
    BOUNDARY_CACHE_DAYS: float = float(os.getenv("BOUNDARY_CACHE_DAYS", "90"))

    # Phase 12.5g — POI shortcut lookups (hospital/school/pharmacy/fire
    # station/police/cooling-center) are a whole-city Overpass query,
    # which is genuinely slow on a big metro's bbox (many seconds, plus
    # Overpass's own 429/504 retry backoff on top). These barely change
    # day to day, so cache the raw per-city/category result the same way
    # the boundary polygon is cached — a repeat pick of "Hospital" for
    # the same city becomes a Postgres read instead of a fresh Overpass
    # round trip. Shorter than BOUNDARY_CACHE_DAYS since POIs (a new
    # pharmacy opening, a fire station closing) churn faster than city
    # limits do.
    POI_CACHE_DAYS: float = float(os.getenv("POI_CACHE_DAYS", "7"))
    # A candidate route is rejected as "not really within this city" when
    # FEWER than this fraction of its sampled points fall inside the
    # cached boundary polygon (see geo_utils.fraction_inside_boundary).
    # Not 1.0 on purpose — a route can legitimately clip a highway
    # shoulder or bridge approach just outside the strict admin line
    # without actually leaving the area the user cares about.
    ROUTE_BOUNDARY_MIN_INSIDE_FRACTION: float = float(os.getenv("ROUTE_BOUNDARY_MIN_INSIDE_FRACTION", "0.85"))

    # --- Phase 12.5c: whole-route-response query cache ---
    # See route_query_cache.py. Coordinates are snapped to this grid
    # before hashing, so a request a few hundred meters off an earlier
    # one (GPS jitter, a different door on the same block) still hits the
    # same cached response instead of paying for a fresh provider+
    # FortyGuard round trip. Same width as ROUTE_POINT_GRID_DEG (~1km) —
    # no reason for the two to disagree.
    ROUTE_QUERY_CACHE_GRID_DEG: float = float(os.getenv("ROUTE_QUERY_CACHE_GRID_DEG", "0.01"))
    # Kept short relative to BOUNDARY_CACHE_DAYS/EXPOSURE_CACHE_DAYS on
    # purpose: FortyGuard's forecast for a given hour can itself update
    # the closer that hour gets (same reasoning as heat_story_forecasts),
    # so a route response is only reused for a short window, not treated
    # as durably correct the way a city boundary is.
    ROUTE_QUERY_CACHE_MINUTES: float = float(os.getenv("ROUTE_QUERY_CACHE_MINUTES", "15"))

    # Default weight route_heat_scoring.label_routes uses to pick the
    # "balanced" route when a request doesn't specify its own
    # RouteRequest.heat_weight (see schemas.py) — 0.0 = pure fastest,
    # 1.0 = pure coolest. See label_routes' own docstring for why 0.55.
    ROUTE_DEFAULT_HEAT_WEIGHT: float = float(os.getenv("ROUTE_DEFAULT_HEAT_WEIGHT", "0.55"))

settings = Settings()