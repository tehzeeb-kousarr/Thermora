"""
Phase 10 — Heat Emergency Mode.

Threshold-based trigger, deliberately rules-based rather than AI-generated
— per the roadmap: "keeps it auditable/fast". This module makes no
network calls and no LLM calls; it only combines three things Phases 7-9
already computed:

  - Phase 7's official NWS alerts (alerts_repository.get_alerts) — the
    VERIFY step: "is this an officially recognized event?"
  - Phase 8's Heat Risk Score (risk_score.compute_risk_score) — how bad
    the heat itself is.
  - Phase 9's People Impact Score (impact_score.compute_impact_score) —
    heat combined with real exposure (schools/hospitals/density).

Same philosophy as risk_score.py and impact_score.py: every number in the
output is traceable back to a specific upstream factor, nothing is
inferred or generated freeform. Three trigger rules, checked
independently (any one firing is enough to declare EMERGENCY):

  1. official_alert   — NWS already has an active Extreme/Severe alert
                         for this location. Thermora doesn't invent this
                         signal, it surfaces and prioritizes it.
  2. impact_critical   — Phase 9's People Impact Score is in its
                         "Critical" band (>=75) — heat + real exposure
                         together, not heat alone.
  3. risk_severe       — Phase 8's Heat Risk Score alone is in its
                         "Severe" band (>=75), even without exposure
                         data (e.g. Impact Score isn't available yet for
                         this city/date).

Below EMERGENCY but above the "High" band on either score, status is
WATCH rather than NORMAL — elevated conditions worth surfacing, but not
yet an actioned trigger. This mirrors risk_score.py/impact_score.py's own
LEVELS bands (25/50/75) rather than inventing a new scale.
"""

# Mirrors risk_score.LEVELS / impact_score.LEVELS "Severe"/"Critical" and
# "High" floors exactly, rather than picking new numbers — a score of 75
# here means the same thing it already means on the Risk/Impact cards.
TRIGGER_IMPACT_THRESHOLD = 75.0  # Impact Score "Critical" floor
TRIGGER_RISK_THRESHOLD = 75.0    # Heat Risk Score "Severe" floor
WATCH_IMPACT_THRESHOLD = 50.0    # Impact Score "High" floor
WATCH_RISK_THRESHOLD = 50.0      # Heat Risk Score "High" floor

# NWS severities that count as an official trigger. "Moderate"/"Minor"
# alerts exist in NWS's schema too but aren't treated as emergency-grade
# here — they still show up in reasons/status via the WATCH path if the
# scores are also elevated, they just don't unilaterally force EMERGENCY.
OFFICIAL_TRIGGER_SEVERITIES = {"Extreme", "Severe"}

STATUS_META = {
    "EMERGENCY": {"label": "Active Emergency", "color": "red"},
    "WATCH": {"label": "Elevated — Watching", "color": "amber"},
    "NORMAL": {"label": "Normal", "color": "emerald"},
}


def _breakdown_by_key(result: dict | None) -> dict:
    """risk_result/impact_result's `breakdown` list, indexed by factor
    key, for quick lookup of a specific sub-score/raw_value below."""
    if not result or not result.get("available"):
        return {}
    return {f["key"]: f for f in result.get("breakdown", [])}


def _dominant_factor(breakdown_by_key: dict) -> dict | None:
    """The single factor contributing the most points to its score —
    used to make actions specific ('wet-bulb is the driver') rather than
    generic, without inventing anything not already in the breakdown."""
    if not breakdown_by_key:
        return None
    return max(breakdown_by_key.values(), key=lambda f: f.get("contribution", 0))


# Generic-but-genuinely-useful actions used ONLY to top up a real,
# data-driven candidate list up to MIN_ACTIONS — never a substitute for
# reading the actual factors. Each still explains WHY relative to the
# specific status, not boilerplate.
def _fallback_actions(status: str) -> list[dict]:
    if status == "EMERGENCY":
        return [
            {"priority": "P2", "action": "Activate the emergency communications plan (public alerts, city website, social channels).",
             "why": "An Emergency-level trigger fired — the public needs to hear it from an official channel, not just see it on a dashboard."},
            {"priority": "P2", "action": "Brief EMS/fire dispatch on the affected zone before call volume rises.",
             "why": "Heat-related EMS calls typically lag the actual heat by hours — briefing ahead of that lag is cheap insurance."},
            {"priority": "P3", "action": "Re-check this status within the hour — Heat Risk and Impact Scores are computed from live data and can change.",
             "why": "This trigger reflects conditions at the time it was computed, not a forecast — conditions can improve or worsen."},
        ]
    return [  # WATCH
        {"priority": "P3", "action": "Pre-position cooling/hydration resources in case conditions escalate to Emergency.",
         "why": "Cheaper to stage resources during Watch than to mobilize them cold during an active Emergency."},
        {"priority": "P3", "action": "Notify school/hospital facility managers in the area of elevated (not yet critical) conditions.",
         "why": "A heads-up at Watch level gives vulnerable-site staff time to adjust before conditions reach Emergency thresholds."},
        {"priority": "P3", "action": "Review tomorrow's outdoor-work and event schedules against the forecast trend.",
         "why": "Watch status is often the last point where a schedule change is still easy to make."},
    ]


MIN_ACTIONS = 4


def _build_actions(
    status: str,
    official: dict | None,
    risk_result: dict | None,
    impact_result: dict | None,
) -> list[dict]:
    """Every action below is conditioned on an ACTUAL value from Phase
    7/8/9's output — the factor that's elevated, the specific exposure
    counts found, which alert is active — never a fixed template applied
    regardless of what the data says. Guarantees at least MIN_ACTIONS by
    falling back to _fallback_actions() only after the real, specific
    candidates are exhausted."""
    risk_by_key = _breakdown_by_key(risk_result)
    impact_by_key = _breakdown_by_key(impact_result)
    exposure_counts = (impact_result or {}).get("exposure_counts") or {}
    schools = exposure_counts.get("schools") or 0
    hospitals = exposure_counts.get("hospitals") or 0

    actions: list[dict] = []

    if official is not None:
        actions.append({
            "priority": "P1",
            "action": "Issue a public warning aligned with the official NWS alert.",
            "why": f"NWS already has an active {official.get('severity')} alert "
                   f"(\u201c{official.get('headline') or official.get('alert_type')}\u201d) — Thermora is "
                   "confirming and prioritizing an existing government warning, not originating a new one.",
        })

    # Wet-bulb near/at the physiological ceiling is categorically more
    # urgent than any other single factor — called out on its own
    # whenever it's genuinely the reading driving the score, not just
    # whenever risk is high for some other reason.
    wet_bulb = risk_by_key.get("wet_bulb_c")
    if wet_bulb and wet_bulb["raw_value"] >= 33:
        actions.append({
            "priority": "P1",
            "action": f"Advise against ANY sustained outdoor exertion — wet-bulb temperature is {wet_bulb['raw_value']}°C.",
            "why": "Above ~35°C wet-bulb the human body physically cannot cool itself by sweating. "
                   f"{wet_bulb['raw_value']}°C is close enough to that ceiling that normal hydration/rest "
                   "precautions are no longer sufficient on their own.",
        })

    if schools > 0:
        actions.append({
            "priority": "P1",
            "action": f"Contact the {schools} school(s) in this zone directly — advise indoor recess or early dismissal.",
            "why": "Phase 6's OSM exposure data found schools inside the scored area — a concentrated, "
                   "harder-to-relocate population that can't self-direct to safety.",
        })

    if hospitals > 0:
        actions.append({
            "priority": "P1" if status == "EMERGENCY" else "P2",
            "action": f"Alert the {hospitals} hospital(s)/clinic(s) in this zone to expect increased heat-related admissions.",
            "why": "OSM exposure data found hospitals/clinics inside the scored area — advance notice helps "
                   "them staff and stock for a predictable surge rather than reacting to it.",
        })

    if impact_result and impact_result.get("available") and impact_result["score"] >= 75:
        actions.append({
            "priority": "P1",
            "action": "Open the nearest cooling center(s) and publicize their locations.",
            "why": f"People Impact Score is {impact_result['score']} (Critical) — heat combined with real "
                   "population/site exposure, the strongest combined signal this module reads.",
        })

    exceedance = risk_by_key.get("exceedance_hours")
    if exceedance and exceedance["raw_value"] >= 8:
        actions.append({
            "priority": "P2",
            "action": f"Extend cooling center hours to cover the full high-heat window (~{exceedance['raw_value']:.0f}h today).",
            "why": "FortyGuard's exceedance metric shows this many hours above threshold today — a short "
                   "midday-only cooling window won't cover the actual exposure duration.",
        })

    persistence = risk_by_key.get("persistence_hours")
    if persistence and persistence["raw_value"] >= 6:
        actions.append({
            "priority": "P2",
            "action": f"Check on elderly/isolated residents — heat has persisted {persistence['raw_value']:.0f}h continuously with no break.",
            "why": "FortyGuard's persistence metric shows an unbroken stretch above threshold — no natural "
                   "overnight cooldown to rely on, which disproportionately affects people who live alone.",
        })

    aqi = risk_by_key.get("aqi")
    if aqi and aqi["raw_value"] >= 100:
        actions.append({
            "priority": "P2",
            "action": f"Pair the heat warning with an air-quality advisory — AQI is {aqi['raw_value']:.0f}.",
            "why": "Heat and poor air quality compound cardiovascular/respiratory strain — this is a "
                   "combined-hazard message, not two separate ones.",
        })

    density = impact_by_key.get("population_density")
    if density and density["sub_score"] >= 70:
        actions.append({
            "priority": "P2",
            "action": "Deploy mobile hydration/cooling resources to the highest-density blocks in this zone.",
            "why": f"OSM building density in this AOI scores {density['sub_score']}/100 — a fixed single "
                   "cooling center is less effective across a genuinely dense built-up area.",
        })

    risk_dominant = _dominant_factor(risk_by_key)
    if (
        risk_result and risk_result.get("available") and risk_result["score"] >= 50
        and risk_dominant and risk_dominant["key"] not in {"wet_bulb_c"}
        and len(actions) < MIN_ACTIONS
    ):
        actions.append({
            "priority": "P2" if status == "EMERGENCY" else "P3",
            "action": f"Suspend or reschedule outdoor work/activity during peak hours — driven mainly by {risk_dominant['label']} ({risk_dominant['raw_value']}{risk_dominant.get('unit', '')}).",
            "why": f"{risk_dominant['label']} is the largest single contributor to today's Heat Risk Score "
                   f"({risk_dominant['contribution']} of {risk_result['score']} points).",
        })

    for fallback in _fallback_actions(status):
        if len(actions) >= MIN_ACTIONS:
            break
        actions.append(fallback)

    return actions


def _official_trigger_alert(alerts: list[dict]) -> dict | None:
    """First active alert whose severity is emergency-grade, or None.
    `alerts` is exactly the list alerts_repository.get_alerts() returns
    — no re-shaping needed."""
    for alert in alerts or []:
        if alert.get("severity") in OFFICIAL_TRIGGER_SEVERITIES:
            return alert
    return None


def compute_emergency_status(
    risk_result: dict | None,
    impact_result: dict | None,
    alerts: list[dict] | None,
) -> dict:
    """`risk_result` is risk_score.compute_risk_score()'s return value,
    `impact_result` is impact_score.compute_impact_score()'s return
    value, `alerts` is alerts_repository.get_alerts()'s `alerts` list —
    all for the same city/date. This function does no fetching; the
    router is responsible for gathering these three the same way
    routers/impact.py and routers/alerts.py already do."""
    alerts = alerts or []
    risk_available = bool(risk_result and risk_result.get("available"))
    impact_available = bool(impact_result and impact_result.get("available"))
    risk_value = risk_result["score"] if risk_available else None
    impact_value = impact_result["score"] if impact_available else None

    official = _official_trigger_alert(alerts)
    reasons: list[dict] = []
    triggered = False

    if official is not None:
        triggered = True
        reasons.append({
            "rule": "official_alert",
            "detail": (
                f"NWS has an active {official.get('severity')} alert: "
                f"\u201c{official.get('headline') or official.get('alert_type')}\u201d."
            ),
        })

    if impact_available and impact_value >= TRIGGER_IMPACT_THRESHOLD:
        triggered = True
        reasons.append({
            "rule": "impact_critical",
            "detail": (
                f"People Impact Score is {impact_value} (Critical, "
                f"\u2265{TRIGGER_IMPACT_THRESHOLD:.0f}) — heat risk combined with real "
                f"population/site exposure, not heat alone."
            ),
        })

    if risk_available and risk_value >= TRIGGER_RISK_THRESHOLD:
        triggered = True
        reasons.append({
            "rule": "risk_severe",
            "detail": f"Heat Risk Score is {risk_value} (Severe, \u2265{TRIGGER_RISK_THRESHOLD:.0f}).",
        })

    if triggered:
        status = "EMERGENCY"
    elif (risk_available and risk_value >= WATCH_RISK_THRESHOLD) or (
        impact_available and impact_value >= WATCH_IMPACT_THRESHOLD
    ):
        status = "WATCH"
        # Cites the actual score(s) that pushed this into WATCH — matches
        # how the EMERGENCY reasons above always name a specific number
        # and threshold, rather than the generic "Risk and/or Impact is
        # elevated" line this used to produce regardless of which one
        # (or both) actually crossed the line.
        watch_bits = []
        if risk_available and risk_value >= WATCH_RISK_THRESHOLD:
            watch_bits.append(
                f"Heat Risk Score is {risk_value} (High, \u2265{WATCH_RISK_THRESHOLD:.0f})"
            )
        if impact_available and impact_value >= WATCH_IMPACT_THRESHOLD:
            watch_bits.append(
                f"People Impact Score is {impact_value} (High, \u2265{WATCH_IMPACT_THRESHOLD:.0f})"
            )
        reasons.append({
            "rule": "elevated_not_triggered",
            "detail": " and ".join(watch_bits) + ", but below the Emergency trigger "
                      "and no official Extreme/Severe alert is active.",
        })
    else:
        status = "NORMAL"
        if not risk_available and not impact_available and official is None:
            reasons.append({
                "rule": "no_data",
                "detail": "No Risk Score, Impact Score, or NWS alert data is available "
                          "yet for this city/date — status defaults to Normal rather "
                          "than assuming safety.",
            })
        else:
            # The common, everyday case: real data, genuinely below every
            # threshold. This used to leave `reasons` empty, which meant
            # the frontend's "why this status" section silently never
            # rendered on an ordinary day — Normal looked self-evident
            # when it should be just as traceable as Watch/Emergency.
            # Only states the scores/alert status that are actually
            # available; never claims a number for a score that wasn't
            # computed (e.g. Impact Score not available yet for this
            # city/date).
            normal_bits = []
            if risk_available:
                normal_bits.append(
                    f"Heat Risk Score is {risk_value} ({risk_result.get('level')}, "
                    f"below the {WATCH_RISK_THRESHOLD:.0f} Watch threshold)"
                )
            if impact_available:
                normal_bits.append(
                    f"People Impact Score is {impact_value} ({impact_result.get('level')}, "
                    f"below the {WATCH_IMPACT_THRESHOLD:.0f} Watch threshold)"
                )
            detail = ". ".join(normal_bits) + "." if normal_bits else "No elevated conditions detected."
            if official is None:
                detail += " No official NWS alert is active."
            reasons.append({
                "rule": "within_normal_range",
                "detail": detail,
            })

    actions = _build_actions(status, official, risk_result, impact_result) if status != "NORMAL" else []

    meta = STATUS_META[status]

    return {
        "status": status,
        "status_label": meta["label"],
        "color": meta["color"],
        "triggered_by_official_alert": official is not None,
        "official_alert": official,
        "risk_score": risk_value,
        "risk_level": risk_result.get("level") if risk_available else None,
        "impact_score": impact_value,
        "impact_level": impact_result.get("level") if impact_available else None,
        "reasons": reasons,
        "actions": actions,
    }