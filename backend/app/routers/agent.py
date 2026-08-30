"""
Phase 15 — Thermora Agent, HTTP surface.

Thin on purpose: every real decision (which tools exist, how the
investigate -> reason -> rank -> explain -> recommend loop runs, how a
failure is classified) lives in agent.py. This module's only job is the
same one every other router in this codebase has — translate an HTTP
request into a call to the real function, and translate a domain error
into an honest HTTP response instead of a raw 500.
"""
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse
import json

from .. import agent
from ..logger import log_err
from ..schemas import AgentQueryRequest

router = APIRouter(prefix="/api/agent", tags=["agent"])


@router.post("/query")
async def query_agent(req: AgentQueryRequest):
    query = (req.query or "").strip()
    if not query:
        raise HTTPException(status_code=400, detail="A non-empty 'query' is required.")

    try:
        return await agent.run_agent(query, history=req.history, active_city_id=req.active_city_id)
    except agent.AgentError as exc:
        # Same convention as every FortyGuardError/GroqError elsewhere in
        # this codebase: an honest, specific failure message the frontend
        # can show directly, never a raw 500 or an invented answer.
        log_err("Agent query failed", {"query": query, "error": str(exc)})
        # A plain HTTPException's `detail` has to stay a string (the
        # frontend does `new Error(data.detail)`, which would just print
        # "[object Object]" for a dict) — retry_after_seconds rides
        # alongside it as its own field instead, so the frontend can read
        # an exact number for its retry countdown without having to
        # regex a number back out of prose that isn't always there (a
        # daily-quota AgentError has no useful seconds-based wait at all;
        # this is simply None for that case, and the frontend treats
        # None as "no countdown to show", not an error).
        return JSONResponse(
            status_code=502,
            content={"detail": str(exc), "retry_after_seconds": exc.retry_after_seconds},
        )


@router.post("/query/stream")
async def query_agent_stream(req: AgentQueryRequest):
    """Streaming twin of POST /query — same request shape, same
    underlying agent.run_agent_stream() loop, same AgentError handling.
    Added alongside the existing endpoint rather than replacing it: the
    non-streaming contract above keeps working exactly as it did before
    this existed, for any caller that doesn't specifically opt into
    streaming.

    Emits newline-delimited Server-Sent Events, one JSON object per
    event: {"type": "status"|"tool_call"|"tool_result"|"final"|"error",
    ...}. Exactly one "final" or "error" event always arrives last —
    the frontend can stop listening once it sees either.

    A mid-stream failure (Groq erroring out after some tool calls already
    ran) can't become an HTTP error status — the response headers/status
    line are already sent by the time that could happen, mid-body. So an
    AgentError here always still arrives as a normal, well-formed
    "error" event within the 200 OK stream, not a 502 the way the
    non-streaming endpoint returns it — the frontend has to check event
    `type`, not HTTP status, to know a stream failed."""
    query = (req.query or "").strip()
    if not query:
        raise HTTPException(status_code=400, detail="A non-empty 'query' is required.")

    async def event_source():
        try:
            async for event in agent.run_agent_stream(query, history=req.history, active_city_id=req.active_city_id):
                yield f"data: {json.dumps(event, default=str)}\n\n"
        except Exception as exc:  # noqa: BLE001 - a truly unexpected failure still has to reach the frontend as an event, not a hung connection
            log_err("Agent stream crashed unexpectedly", {"query": query, "error": str(exc)})
            yield f"data: {json.dumps({'type': 'error', 'detail': 'Something went wrong generating this answer. Please try again.', 'retry_after_seconds': None})}\n\n"

    return StreamingResponse(
        event_source(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            # Disables response buffering on nginx-style reverse proxies —
            # without this, some proxies hold the whole stream until it
            # ends before forwarding anything, defeating the entire point.
            "X-Accel-Buffering": "no",
        },
    )