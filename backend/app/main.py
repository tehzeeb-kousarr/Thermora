from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .db import init_db, close_db
from .logger import log
from .routers import heatmap, env_params, satellite, streetview, heat_intelligence, cities, exposure, alerts, risk, impact, emergency, heat_story, advisor, research, historical, agent as agent_router, routing, city_boundary, places, best_hours
from . import status_tracker
from . import scheduler
from . import repository


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("Starting Thermora backend — initializing database", extra={"tag": "BOOT"})
    await init_db()
    await repository.recover_orphaned_heat_intelligence_jobs()
    log.info("Database ready. Backend up.", extra={"tag": "BOOT"})
    scheduler.start()
    yield
    scheduler.stop()
    await close_db()


app = FastAPI(title="Thermora Backend", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.FRONTEND_ORIGIN],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(heatmap.router)
app.include_router(env_params.router)
app.include_router(satellite.router)
app.include_router(streetview.router)
app.include_router(heat_intelligence.router)
app.include_router(cities.router)
app.include_router(exposure.router)
app.include_router(alerts.router)
app.include_router(risk.router)
app.include_router(impact.router)
app.include_router(emergency.router)
app.include_router(heat_story.router)
app.include_router(advisor.router)
app.include_router(research.router)
app.include_router(historical.router)
app.include_router(agent_router.router)
app.include_router(routing.router)
app.include_router(city_boundary.router)
app.include_router(places.router)
app.include_router(best_hours.router)


@app.get("/api/health")
async def health():
    return {"status": "ok"}


@app.get("/api/status")
async def status():
    """Distinct from /api/health (which only says the process is alive):
    this reports whether FortyGuard itself has been responding, based on
    the outcome of the most recent real calls made to it."""
    return status_tracker.get_status()