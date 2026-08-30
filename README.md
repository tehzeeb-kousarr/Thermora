# Thermora

**A heat-risk intelligence platform that turns live satellite thermal data into decisions people can actually act on.**

Where a weather app shows you a temperature, Thermora shows you a city's actual risk — real thermal tiles, real exposure data (schools, hospitals, roads, building density), and a real-data-grounded AI agent, brought together into one live picture per city. Every number on screen traces back to an actual fetched reading. Nothing is modeled, interpolated, or invented — if the data isn't there yet, Thermora fetches it live rather than guessing, and says so honestly when it genuinely can't.

Built for the people who have to make a call about heat, not just check the forecast: municipal heat officers, emergency services directors, facility operations managers, public health analysts, and residents who just need a straight answer.

---

## Table of contents

- [What it does](#what-it-does)
- [The FortyGuard Temperature API](#the-fortyguard-temperature-api)
- [Architecture](#architecture)
- [Tech stack](#tech-stack)
- [Getting started](#getting-started)
- [Environment variables](#environment-variables)
- [Project structure](#project-structure)
- [API overview](#api-overview)
- [Data sources](#data-sources)
- [AI usage disclosure](#ai-usage-disclosure)

---

## What it does

| Tab | What it's for |
|---|---|
| **Dashboard** | A city's current Risk Score, Impact Score, and Local Advisor — persona-specific precautions (resident, outdoor worker, farmer, business owner) computed from real current conditions. |
| **Heat Map** | Live, interactive thermal tiles for any monitored city — adjustable granularity, threshold, and analytic type (exceedance vs. persistence). |
| **Compare / Time Compare** | Put two or three cities, or two time windows, side by side to see how heat actually differs across place or across a season. |
| **Research** | A historical record across a date range, with per-day data-coverage shown honestly, and a "fetch missing data" action for days that were never fully measured. |
| **Heat Story** | An hour-by-hour narrative of a specific day's heat event for a city, grounded entirely in observed data. |
| **Emergency Mode** | A live timeline of exactly when a city crossed its warning and emergency thresholds today. |
| **Route Heat** | A→B route options scored for heat exposure along the way — "Fastest" vs. "Coolest" vs. "Balanced" — plus a "best hours to travel" timeline for a fixed location. |
| **AI Agent** | A tool-calling agent that reasons over the same real engines every other tab uses — never answers from general knowledge when a real number is needed, and shows its tool-call trail transparently. |

## The FortyGuard Temperature API

FortyGuard is Thermora's core data source — every real temperature reading, every Risk Score, every Heat Story, and every threshold crossing shown anywhere in the app is ultimately built on a genuine FortyGuard response, never a model or an estimate.

Thermora talks to FortyGuard across three distinct time directions:

- **Live conditions** — the current hour's thermal tiles for a city's area of interest, fetched on demand the moment they're needed and cached in Postgres so the same hour is never re-fetched from FortyGuard twice.
- **Historical data** — past hourly readings, up to roughly **2 months back**, fetched and stored permanently once retrieved. Every tab (Dashboard, Heat Map, Heat Story, Research) reads from this same stored record rather than re-querying FortyGuard for data that's already been fetched.
- **Forecast data** — short-range projections up to **12 hours ahead** of the current moment, which is FortyGuard's own forecast horizon. Ask Thermora about a date beyond that and it will say so honestly rather than guess.

**How a request is built:** each city has a fixed geographic area of interest (a bounding box around its center point). A FortyGuard heatmap request combines that AOI with a date/hour, a **granularity** (tile resolution), a **filter type** (single hour vs. full day), and — for the deeper analytics — an **analytic type** of either `exceedance` (how many hours a location spent above a chosen threshold) or `persistence` (how sustained that heat was), each queried and stored completely independently so one never overwrites the other.

**How requests are managed:**
- FortyGuard jobs are asynchronous — Thermora submits a request, then polls for completion, with real exponential backoff on rate limits and transient errors.
- Every request is de-duplicated by a signature (city + query parameters) — two near-simultaneous callers asking for the exact same thing share one real FortyGuard submission instead of firing two.
- A completed result with zero tiles (e.g. an area smaller than one tile at the requested granularity) is never silently served as if it were valid — Thermora surfaces that honestly and offers a real retry, which triggers a genuinely fresh FortyGuard fetch.

## Architecture

```
┌─────────────┐      HTTP/JSON       ┌──────────────┐      HTTPS       ┌─────────────────┐
│   Frontend   │ ───────────────────▶ │   Backend    │ ───────────────▶ │   FortyGuard     │
│ React + Vite │ ◀─────────────────── │   FastAPI    │ ◀─────────────── │  Temperature API │
└─────────────┘                      └──────┬───────┘                  └─────────────────┘
                                             │
                                             ├──▶ Postgres (permanent store — every fetched
                                             │     hour, every score, every alert)
                                             ├──▶ Groq (LLM — AI Agent, Heat Story, Local
                                             │     Advisor wording, Research summaries)
                                             ├──▶ National Weather Service (active alerts)
                                             └──▶ OpenStreetMap / Overpass / Geoapify
                                                   (exposure data — schools, hospitals,
                                                   roads, building density)
```

## Tech stack

**Backend**
- FastAPI + Uvicorn
- PostgreSQL via `asyncpg`
- `httpx` for all outbound API calls (FortyGuard, Groq, NWS, Overpass, Geoapify)
- Pydantic for request/response schemas

**Frontend**
- React 19 + Vite
- Tailwind CSS v4
- Leaflet (interactive heat maps)
- Recharts (charts)
- `lucide-react` (icons), `motion` (animation)

## Getting started

### Prerequisites
- Python 3.11+
- Node.js 18+
- PostgreSQL (local or hosted)
- A FortyGuard API key
- A Groq API key (for AI features — the app runs without it, but the AI Agent, Heat Story, Local Advisor wording, and Research summaries will degrade to their non-LLM fallbacks)

### Backend

```bash
cd backend
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt

cp .env.example .env    # fill in FORTYGUARD_API_KEY, GROQ_API_KEY, Postgres credentials
uvicorn app.main:app --reload
```

The backend creates its own database and tables on first boot — no manual migration step needed. It listens on `http://localhost:8000` by default.

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Runs on `http://localhost:5173` by default, and proxies `/api/*` straight to the backend in dev (see `vite.config.js`) — no `VITE_API_URL` needed locally.

## Environment variables

Set in `backend/.env`:

| Variable | Required | Purpose |
|---|---|---|
| `FORTYGUARD_API_KEY` | **Yes** | Core temperature data — the app cannot start without this. |
| `FORTYGUARD_BASE_URL` | No | Defaults to FortyGuard's production endpoint. |
| `POSTGRES_HOST` / `POSTGRES_PORT` / `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | No (sensible local defaults) | Where Thermora stores everything it fetches. |
| `GROQ_API_KEY` | No | Powers the AI Agent, Heat Story, Local Advisor wording, Research summaries. |
| `GROQ_API_KEYS` | No | Comma-separated list of Groq keys for higher aggregate throughput; falls back to `GROQ_API_KEY` alone if unset. |
| `GROQ_MODEL` | No | Defaults to `openai/gpt-oss-120b`. |
| `NWS_USER_AGENT` | No | Required by the National Weather Service's API etiquette policy for alerts. |
| `GEOAPIFY_API_KEY` | No | Authenticated fallback for exposure data (schools/hospitals/density) when Overpass is unavailable. |
| `FRONTEND_ORIGIN` | No | CORS — set to your deployed frontend's exact URL in production. |

In `frontend/.env` (production only):

| Variable | Purpose |
|---|---|
| `VITE_API_URL` | Your deployed backend's URL. Not needed in dev (Vite proxies `/api` automatically). |

## Project structure

```
backend/
  app/
    main.py                 # FastAPI app + router registration
    config.py                # All environment variables, centralized
    fortyguard_client.py     # FortyGuard API client
    repository.py            # Fetch/cache/coordination layer over Postgres + FortyGuard
    location_features.py     # Derived per-city, per-hour feature storage
    risk_score.py / advisor.py / heat_story.py   # Scoring + narrative logic
    agent.py                 # AI Agent — tool definitions, orchestration loop
    routers/                 # One router per API surface (cities, heatmap, research, agent, ...)
  scripts/
  tests/

frontend/
  src/
    components/              # One component per tab/view
    hooks/                   # Shared data-fetching hooks
    lib/                     # Formatting, query-window, and client-side data-store logic
    api/                     # Backend API call wrappers
```

## API overview

All endpoints are prefixed `/api`. Selected routers:

- `cities` — monitored city list, current status, per-city summaries
- `heatmap` — submit/poll thermal tile requests
- `risk` / `impact` — Risk Score and Impact Score computation
- `emergency` — today's threshold-crossing timeline
- `heat-story` — narrated daily heat events
- `research` — historical range queries + gap-filling
- `advisor` — persona-specific precautions
- `routing` / `best-hours` — heat-aware routing and best-time-to-travel
- `agent` — the AI Agent's single query endpoint

## Data sources

| Source | Used for |
|---|---|
| **FortyGuard** | Live, historical, and forecast temperature tiles — the core dataset (see above). |
| **National Weather Service** | Active weather alerts for a city's area. |
| **OpenStreetMap (via Overpass)** | Exposure data — schools, hospitals, roads, building density. |
| **Geoapify** | Authenticated fallback for exposure data when Overpass is unreachable. |
| **Groq** | Language generation on top of already-fetched real data — never the source of a number itself. |

## AI usage disclosure

- **Groq** (`openai/gpt-oss-120b`) powers the AI Agent, Local Advisor wording, Heat Story narration, and Research summaries — always generating language *on top of* real, already-fetched Thermora/FortyGuard data, never inventing the underlying numbers.
