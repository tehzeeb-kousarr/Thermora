import React, { useState, useEffect, useRef } from 'react';
import {
  Sparkles, X, Send, Bot, User, Flame, CheckCircle2, ShieldAlert, HelpCircle, Clock,
  RefreshCw, Copy, Check, ChevronDown, ChevronRight, Wrench, History, AlertTriangle,
  TrendingUp, ArrowRight, Users, RotateCcw, Globe2, MapPin, Layers, BookOpen, Zap,
  CloudSun, ListChecks,
} from 'lucide-react';
import { apiUrl } from '../config/api';

// Honest, generic "still working" phrasing — NOT a claim about which
// specific tool is running right now (the backend doesn't stream, so
// there's no real signal to reflect literally); just enough variety that
// a multi-second wait doesn't sit on one static line the whole time.
const THINKING_PHRASES = [
  'Investigating — calling Thermora\'s real engines, not guessing…',
  'Cross-checking Risk Score, alerts, and Emergency status…',
  'Ranking whatever it finds by urgency…',
  'Grounding every number in an actual tool call…',
];

// Same three-state convention Emergency Mode / Risk Score use elsewhere —
// not invented here, just applied to however the agent's own tools
// (which call those exact same engines) classified each city.
const STATUS_STYLES = {
  EMERGENCY: { badge: 'bg-red-500/20 text-red-300 border-red-500/40', dot: 'bg-red-500', ring: 'border-red-500/30' },
  WATCH: { badge: 'bg-amber-500/20 text-amber-300 border-amber-500/40', dot: 'bg-amber-500', ring: 'border-amber-500/30' },
  NORMAL: { badge: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40', dot: 'bg-emerald-500', ring: 'border-emerald-500/30' },
};

function statusStyle(status) {
  return STATUS_STYLES[status] || { badge: 'bg-surface2 text-inkmuted border-border', dot: 'bg-inkfaint', ring: 'border-border' };
}

// One real tool -> one icon, purely cosmetic (which real engine got
// called is still the actual `call.tool` name shown in mono below it) —
// makes the investigation trail scannable at a glance instead of every
// step looking identical.
const TOOL_ICONS = {
  list_monitored_cities: Globe2,
  get_all_cities_status: Layers,
  get_city_status: MapPin,
  get_multiple_cities_status: Layers,
  get_hourly_breakdown: Clock,
  get_heat_story: BookOpen,
  get_local_advisory: Users,
  get_historical_trend: History,
  get_historical_date: History,
  fetch_live_conditions: Zap,
  fetch_forecast_temperature: CloudSun,
};

// One tool call from the transcript, rendered as a single compact line —
// this is deliberately not the full tool result (that already went to
// the model); it's just enough for a person to see WHAT was checked,
// which is the whole point of showing this at all: nothing in the
// summary above should feel like it came from nowhere. `index` only
// drives the stagger animation's timing — the DATA here is exactly the
// same real tool/arguments/result_preview the backend transcript sent,
// nothing invented for the animation's sake.
function ToolCallRow({ call, index, isLast }) {
  const Icon = TOOL_ICONS[call.tool] || Wrench;
  const argsText = call.arguments && Object.keys(call.arguments).length
    ? Object.entries(call.arguments).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`).join(' · ')
    : null;
  const preview = call.result_preview || {};
  const isError = !!preview.error;
  const previewText = isError
    ? preview.error
    : Object.entries(preview).filter(([, v]) => v != null).map(([k, v]) => `${k}: ${v}`).join(' · ');

  return (
    <div
      className="relative flex items-start gap-2.5 pb-3 last:pb-0 animate-stepIn"
      style={{ animationDelay: `${index * 90}ms` }}
    >
      {/* Connecting line down to the next step — same visual language as
          a build/CI pipeline's step timeline, so a multi-tool
          investigation visibly reads as a SEQUENCE of real actions. */}
      {!isLast && <span className="absolute left-[13px] top-6 bottom-0 w-px bg-border/70" />}
      <span
        className={`relative z-10 shrink-0 w-[26px] h-[26px] rounded-full flex items-center justify-center border ${
          isError ? 'bg-red-500/15 border-red-500/40 text-red-300' : 'bg-orange-500/15 border-orange-500/40 text-orange-300'
        }`}
      >
        <Icon className="w-3 h-3" />
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] font-mono font-bold text-orange-300">{call.tool}</span>
          {argsText && <span className="text-[10px] font-mono text-inkfaint truncate">({argsText})</span>}
        </div>
        {previewText && (
          <div className={`text-[10px] font-mono mt-0.5 ${isError ? 'text-red-300' : 'text-inkmuted'}`}>
            → {previewText}
          </div>
        )}
      </div>
    </div>
  );
}

// One city's prioritized entry — the "rank -> explain -> recommend" part
// of the agent's own investigate/reason/rank/explain/recommend structure,
// made visible instead of buried in a paragraph.
function PriorityCard({ p }) {
  const style = statusStyle(p.status);
  return (
    <div className={`rounded-xl border ${style.ring} bg-app/50 p-3`}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${style.dot}`} />
          <span className="text-xs font-bold text-ink">{p.city_name || p.city_id}</span>
        </div>
        <span className={`px-2 py-0.5 rounded-md text-[10px] font-bold border ${style.badge}`}>{p.status}</span>
      </div>
      <div className="flex items-center gap-3 mt-1.5 text-[10px] font-mono text-inkmuted">
        <span>Risk: <span className="text-inksoft font-semibold">{p.risk_score != null ? Math.round(p.risk_score) : '—'}</span></span>
        <span>Impact: <span className="text-inksoft font-semibold">{p.impact_score != null ? Math.round(p.impact_score) : '—'}</span></span>
      </div>
      {p.why && <p className="text-[11px] text-inksoft mt-2 leading-relaxed">{p.why}</p>}
      {p.recommended_action && (
        <div className="flex items-start gap-1.5 mt-2 pt-2 border-t border-border/50">
          <ArrowRight className="w-3 h-3 text-orange-400 shrink-0 mt-0.5" />
          <p className="text-[11px] text-orange-200 font-medium leading-relaxed">{p.recommended_action}</p>
        </div>
      )}
    </div>
  );
}

// The full structured investigation — summary, ranked priorities,
// historical context, caveats, and (collapsed by default) exactly what
// was checked to produce all of it.
function AgentResult({ result }) {
  // Open by default — the real, multi-tool investigation trail IS the
  // best evidence this is a genuine agent and not a canned response, so
  // it's shown immediately rather than hidden behind a click. Still
  // collapsible for anyone who just wants the summary.
  const [showTranscript, setShowTranscript] = useState(true);
  const toolCalls = result.tool_calls || [];

  if (result.needs_clarification) {
    return (
      <div className="space-y-2">
        <div className="flex items-start gap-2 p-2.5 rounded-xl bg-orange-500/10 border border-orange-500/30">
          <HelpCircle className="w-3.5 h-3.5 text-orange-300 shrink-0 mt-0.5" />
          <p className="text-xs leading-relaxed text-ink font-medium">{result.needs_clarification}</p>
        </div>
        {result.summary && <p className="text-[11px] text-inkmuted leading-relaxed">{result.summary}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-ink font-medium">{result.summary}</p>

      {result.priorities && result.priorities.length > 0 && (
        <div className="space-y-2">
          {result.priorities.map((p, i) => <PriorityCard key={p.city_id || i} p={p} />)}
        </div>
      )}

      {result.historical_context && (
        <div className="flex items-start gap-2 p-2.5 rounded-xl bg-sky-500/10 border border-sky-500/25">
          <History className="w-3.5 h-3.5 text-sky-300 shrink-0 mt-0.5" />
          <p className="text-[11px] text-sky-100 leading-relaxed">{result.historical_context}</p>
        </div>
      )}

      {result.persona_advisory && (
        <div className="flex items-start gap-2 p-2.5 rounded-xl bg-violet-500/10 border border-violet-500/25">
          <Users className="w-3.5 h-3.5 text-violet-300 shrink-0 mt-0.5" />
          <p className="text-[11px] text-violet-100 leading-relaxed">{result.persona_advisory}</p>
        </div>
      )}

      {result.notes && (
        <div className="flex items-start gap-2 p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/25">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-300 shrink-0 mt-0.5" />
          <p className="text-[11px] text-amber-100 leading-relaxed">{result.notes}</p>
        </div>
      )}

      {/* Where to go for the full breakdown behind this summary — built
          from the transcript's own tool names server-side (agent.py's
          _build_see_also), never written by the model itself, so this
          can't point somewhere that doesn't actually match what was
          investigated. Was already computed on every response but never
          rendered anywhere until now. */}
      {result.see_also && result.see_also.length > 0 && (
        <div className="flex items-start gap-2 p-2.5 rounded-xl bg-surface2/60 border border-border">
          <MapPin className="w-3.5 h-3.5 text-inkfaint shrink-0 mt-0.5" />
          <div className="text-[11px] text-inkmuted leading-relaxed">
            <span className="font-semibold text-inksoft">For the full breakdown: </span>
            {result.see_also.join(' · ')}
          </div>
        </div>
      )}

      {toolCalls.length > 0 && (
        <div className="pt-1">
          <button
            onClick={() => setShowTranscript((s) => !s)}
            className="flex items-center gap-1.5 text-[10px] font-mono font-bold text-inksoft hover:text-ink transition-colors cursor-pointer"
          >
            {showTranscript ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            <ListChecks className="w-3 h-3 text-orange-400" />
            Live investigation trail — {toolCalls.length} real tool {toolCalls.length === 1 ? 'call' : 'calls'}
          </button>
          {showTranscript && (
            <div className="mt-3 pl-1 border-t border-border/60 pt-3">
              {toolCalls.map((c, i) => (
                <ToolCallRow key={i} call={c} index={i} isLast={i === toolCalls.length - 1} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Retry button for a rate-limited query — when retryAfterSeconds is a
// real number (from Groq's own 429 response, carried through
// routers/agent.py → err.retryAfterSeconds, see the catch block above),
// clicking immediately would just reproduce the identical 429: Groq
// hasn't freed up any budget yet. This counts down for real instead of
// leaving the button clickable the whole time — disabled and ticking
// down while remaining > 0, then flipping to the normal clickable "Retry
// this question" the moment it hits 0. A null/0 retryAfterSeconds (no
// real number available) skips the countdown entirely and behaves
// exactly like the plain retry button always did.
function RetryCountdownButton({ retryAfterSeconds, onRetry, disabled }) {
  const [remaining, setRemaining] = useState(() => Math.max(0, Math.ceil(retryAfterSeconds || 0)));

  useEffect(() => {
    setRemaining(Math.max(0, Math.ceil(retryAfterSeconds || 0)));
  }, [retryAfterSeconds]);

  useEffect(() => {
    if (remaining <= 0) return undefined;
    const id = setInterval(() => {
      setRemaining((r) => Math.max(0, r - 1));
    }, 1000);
    return () => clearInterval(id);
  }, [remaining > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const counting = remaining > 0;

  return (
    <button
      onClick={onRetry}
      disabled={disabled || counting}
      className="mt-1 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-orange-500/15 hover:bg-orange-500/25 border border-orange-500/30 text-orange-300 text-[11px] font-semibold cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed not-prose"
    >
      {counting ? <Clock className="w-3 h-3" /> : <RotateCcw className="w-3 h-3" />}
      {counting ? `Retry in ${remaining}s…` : 'Retry this question'}
    </button>
  );
}

// The very first thing anyone sees when they open the agent — worth a
// real layout instead of a wall of text. Previously this was plain
// **bold** markdown syntax dumped through whitespace-pre-wrap with no
// parser to actually render it, so the literal asterisks showed on
// screen; this replaces that with real visual hierarchy instead.
function WelcomeCard({ cityName }) {
  const capabilities = [
    { icon: Flame, label: `Ask about ${cityName}` },
    { icon: TrendingUp, label: 'Compare cities' },
    { icon: History, label: 'Historical trends' },
    { icon: Clock, label: 'Hour-by-hour today' },
    { icon: Users, label: 'Advice per audience' },
    { icon: ShieldAlert, label: 'Live or forecast' },
  ];
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2.5">
        <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-orange-500 to-red-500 p-0.5 flex items-center justify-center shrink-0 shadow-md shadow-orange-500/20">
          <div className="w-full h-full bg-app rounded-[10px] flex items-center justify-center">
            <Sparkles className="w-4 h-4 text-orange-400" />
          </div>
        </div>
        <div>
          <div className="text-sm font-bold text-ink leading-tight">Hi, I'm the Heat Intelligence Agent</div>
          <div className="text-[10px] text-orange-300/90 font-mono">Investigates before it answers — never guesses</div>
        </div>
      </div>
      <p className="text-[11px] text-inksoft leading-relaxed">
        I call Thermora's real engines before saying anything — Heat Risk Score, People Impact
        Score, official NWS alerts, Emergency Mode, stored historical readings, and live or
        forecast conditions. Nothing here is memorized; if something isn't available, I'll say so
        plainly rather than guess.
      </p>
      <div className="grid grid-cols-2 gap-1.5">
        {capabilities.map(({ icon: Icon, label }) => (
          <div key={label} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-app/60 border border-border/70 text-[10px] text-inksoft font-semibold">
            <Icon className="w-3 h-3 text-orange-400 shrink-0" />
            <span className="truncate">{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Flattens a structured result into plain text for the copy button — the
// UI above is the real presentation; this is just so "Copy" gives
// something readable pasted elsewhere, not [object Object].
function flattenResultToText(result) {
  const lines = [result.summary];
  for (const p of result.priorities || []) {
    lines.push(`\n${p.city_name || p.city_id} — ${p.status} (Risk ${p.risk_score ?? '—'}, Impact ${p.impact_score ?? '—'})`);
    if (p.why) lines.push(p.why);
    if (p.recommended_action) lines.push(`→ ${p.recommended_action}`);
  }
  if (result.historical_context) lines.push(`\nHistorical context: ${result.historical_context}`);
  if (result.persona_advisory) lines.push(`\nAdvisory: ${result.persona_advisory}`);
  if (result.notes) lines.push(`\nNote: ${result.notes}`);
  return lines.join('\n');
}

export const AIAgentDrawer = ({
  isOpen,
  onClose,
  activeCity,
  userSettings,
  initialPrompt,
  onClearInitialPrompt
}) => {
  const [messages, setMessages] = useState([{
    id: 'welcome',
    sender: 'agent',
    isWelcome: true,
    text: `Hi, I'm the Thermora Heat Intelligence Agent. I investigate real Thermora data before answering: Heat Risk Score, People Impact Score, official NWS alerts, Emergency Mode status, stored historical readings, and live or forecast conditions.\n\nI don't have any of that memorized — every number I give you comes from an actual tool call, and I'll say so plainly if something isn't available rather than guess. Ask me about ${activeCity.name}, ask me to compare cities, or ask about historical trends.`,
    time: 'Just now'
  }]);
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  // Real, per-event status text from the streaming endpoint — "Checking
  // Houston...", "Writing the answer...", etc. — null whenever nothing's
  // in flight or no stream event has landed yet (falls back to the
  // cosmetic THINKING_PHRASES cycle in that gap, see the loading
  // indicator below).
  const [liveStatus, setLiveStatus] = useState(null);
  const [thinkingPhraseIdx, setThinkingPhraseIdx] = useState(0);
  const [copiedId, setCopiedId] = useState(null);
  const messagesEndRef = useRef(null);
  const hasTriggeredInitialPrompt = useRef(false);
  const drawerRef = useRef(null);

  // Click-outside-to-close — but "outside" deliberately excludes the tab
  // navigation sidebar (tagged data-agent-nav in Sidebar.jsx): switching
  // tabs is a normal thing to do WHILE chatting with the agent, and
  // should never dismiss it — the drawer stays pinned to the side and
  // the same conversation keeps going underneath whatever tab you're on
  // now. It closes on a genuine outside click (the page content, the
  // header, the backdrop) or the X button — nothing else.
  useEffect(() => {
    if (!isOpen) return undefined;
    const handlePointerDown = (event) => {
      if (drawerRef.current && drawerRef.current.contains(event.target)) return;
      if (event.target.closest('[data-agent-nav]')) return;
      onClose();
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [isOpen, onClose]);

  // Cycles the loading line every ~1.8s while a request is in flight —
  // purely cosmetic variety, not a claim about which specific tool is
  // running right now (see THINKING_PHRASES' own comment above).
  useEffect(() => {
    if (!isLoading) { setThinkingPhraseIdx(0); return undefined; }
    const id = setInterval(() => setThinkingPhraseIdx((i) => (i + 1) % THINKING_PHRASES.length), 1800);
    return () => clearInterval(id);
  }, [isLoading]);
  // Every prompt below either names activeCity explicitly or is
  // genuinely one-tool/cheap — that's deliberate, not incidental. Three
  // real problems these replace:
  // 1. Hardcoded "Houston" regardless of activeCity — wrong answer for
  //    the city actually being viewed the moment someone opens this on
  //    any other city.
  // 2. A hardcoded literal date+time ("29/8/2026 06:00") — guaranteed to
  //    look increasingly odd (eventually a past/nonsensical date) the
  //    longer this ships, for no benefit over just asking about "now".
  // 3. "How does today compare to last month?" with NO city named is the
  //    exact query that previously triggered a real Groq 429: with
  //    nothing to anchor it to one city, the model reached for
  //    get_all_cities_status (live NWS+exposure fan-out across every
  //    monitored city) instead of the cheap, single-city
  //    get_historical_trend call this actually needs — scoping it to
  //    activeCity removes the ambiguity that caused that tool choice.
  const quickPrompts = [
    `What's driving the heat risk in ${activeCity.name} today?`,
    `What is the current heat index in ${activeCity.name}?`,
    `How did today's heat build up hour by hour in ${activeCity.name}?`,
    `What should outdoor workers in ${activeCity.name} do right now?`,
    `How does ${activeCity.name}'s heat today compare to last month?`,
    `What is the heat story today for ${activeCity.name}?`,
    // The one genuinely multi-city, more expensive prompt kept here —
    // real live status across every monitored city is exactly what
    // "which city" requires, so this is a legitimately pricier call,
    // not a wrong tool choice. Kept because ranking cities by risk is a
    // real, valuable capability worth showcasing; if it ever needs
    // trimming for cost, this is the one to drop first.
    "Which monitored cities need attention first right now?",
  ];
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({
      behavior: 'smooth'
    });
  };
  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading]);

  // Handle auto-executing initial prompt when opened with a specific prompt
  useEffect(() => {
    if (isOpen && initialPrompt && initialPrompt.trim()) {
      handleSendMessage(initialPrompt.trim());
      if (onClearInitialPrompt) {
        onClearInitialPrompt();
      }
    }
  }, [isOpen, initialPrompt]);
  // Human-friendly status line for a real streamed tool_call event —
  // "Checking Houston..." beats a raw tool name, but this is purely
  // cosmetic labeling of a REAL event (unlike THINKING_PHRASES' fully
  // invented cycle) — the tool/arguments themselves are exactly what the
  // backend actually just did, never guessed.
  const describeToolCall = (tool, args) => {
    const cityLabel = args?.city_id ? args.city_id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : null;
    const citiesLabel = Array.isArray(args?.city_ids) && args.city_ids.length
      ? `${args.city_ids.length} cities`
      : null;
    switch (tool) {
      case 'list_monitored_cities': return 'Checking which cities are monitored…';
      case 'get_all_cities_status': return 'Checking every monitored city…';
      case 'get_multiple_cities_status': return citiesLabel ? `Checking ${citiesLabel}…` : 'Checking multiple cities…';
      case 'get_city_status': return cityLabel ? `Checking ${cityLabel}…` : 'Checking current conditions…';
      case 'get_hourly_breakdown': return cityLabel ? `Pulling ${cityLabel}'s hourly data…` : 'Pulling hourly data…';
      case 'get_heat_story': return cityLabel ? `Reading ${cityLabel}'s Heat Story…` : 'Reading the Heat Story…';
      case 'get_local_advisory': return cityLabel ? `Building advice for ${cityLabel}…` : 'Building local advice…';
      case 'get_historical_trend': return cityLabel ? `Checking ${cityLabel}'s trend…` : 'Checking the historical trend…';
      case 'get_historical_date': return cityLabel ? `Looking up ${cityLabel}'s past data…` : 'Looking up historical data…';
      case 'fetch_live_conditions': return cityLabel ? `Fetching live data for ${cityLabel}…` : 'Fetching live data…';
      case 'fetch_forecast_temperature': return cityLabel ? `Fetching ${cityLabel}'s forecast…` : 'Fetching the forecast…';
      default: return 'Investigating…';
    }
  };

  const handleSendMessage = async promptToSend => {
    const query = promptToSend || inputText;
    if (!query.trim() || isLoading) return;
    const userMsg = {
      id: Date.now().toString(),
      sender: 'user',
      text: query.trim(),
      time: new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit'
      })
    };
    setMessages(prev => [...prev, userMsg]);
    setInputText('');
    setIsLoading(true);
    setLiveStatus(null);
    try {
      // Sends every real prior turn so far (skipping the synthetic
      // welcome/isWelcome message, which was never actually said by the
      // model) as history — without this, a clarifying question the
      // agent asks has no memory of what was originally asked once the
      // user answers it next turn. See agent.py's run_agent for how this
      // is threaded into the actual Groq messages.
      const history = messages
        .filter((m) => !m.isWelcome)
        .map((m) => ({ role: m.sender === 'agent' ? 'assistant' : 'user', content: m.text }));

      // Streaming endpoint — see routers/agent.py's query_agent_stream
      // and agent.py's run_agent_stream. Same request body, same
      // AgentError semantics as the old single-response /api/agent/query
      // (still there, untouched, for any other caller); the only real
      // difference is this arrives as a sequence of Server-Sent Events
      // instead of one JSON blob, so liveStatus above can show real
      // progress instead of a purely cosmetic loading phrase.
      const response = await fetch(apiUrl('/api/agent/query/stream'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          query: query.trim(),
          history,
          active_city_id: activeCity?.id || null,
          user_context: userSettings?.role?.trim() || null,
        })
      });

      if (!response.ok || !response.body) {
        // The stream endpoint itself failed before ever opening (a
        // genuine network/HTTP-level failure, not an in-stream
        // AgentError — those arrive as a normal "error" event within a
        // 200 OK stream instead, handled in the loop below).
        const data = await response.json().catch(() => null);
        const err = new Error((data && data.detail) || `Agent backend returned ${response.status}`);
        err.retryAfterSeconds = data && typeof data.retry_after_seconds === 'number' ? data.retry_after_seconds : null;
        throw err;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finalData = null;
      let streamError = null;

      // SSE frames are separated by a blank line ("\n\n"); each frame's
      // payload is the text after "data: ". Buffering here because a
      // single read() chunk can split a frame (or bundle several)
      // arbitrarily — network chunking has no relationship to event
      // boundaries.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop(); // last piece may be incomplete — keep it for next chunk

        for (const frame of frames) {
          const line = frame.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          let event;
          try {
            event = JSON.parse(line.slice(6));
          } catch {
            continue; // a malformed frame is skippable — the stream keeps going, not fatal on its own
          }

          if (event.type === 'status') {
            setLiveStatus(event.phase === 'writing_answer' ? 'Writing the answer…' : 'Thinking…');
          } else if (event.type === 'tool_call') {
            setLiveStatus(describeToolCall(event.tool, event.arguments));
          } else if (event.type === 'tool_result') {
            // Deliberately no separate "done checking X" status — the
            // NEXT tool_call or the final writing_answer status
            // naturally supersedes this a moment later, and a person
            // reading a fast-scrolling status line doesn't need a
            // separate "finished" line per step to follow along.
          } else if (event.type === 'final') {
            finalData = event;
          } else if (event.type === 'error') {
            streamError = event;
          }
        }
      }

      if (streamError) {
        const err = new Error(streamError.detail || 'The agent could not complete this request.');
        err.retryAfterSeconds = typeof streamError.retry_after_seconds === 'number' ? streamError.retry_after_seconds : null;
        throw err;
      }
      if (!finalData) {
        throw new Error('The connection closed before an answer arrived. Please try again.');
      }

      const { type: _discardType, ...data } = finalData; // eslint-disable-line no-unused-vars
      const agentMsg = {
        id: (Date.now() + 1).toString(),
        sender: 'agent',
        result: data,
        text: data.needs_clarification || flattenResultToText(data),
        time: new Date().toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit'
        })
      };
      setMessages(prev => [...prev, agentMsg]);
    } catch (err) {
      // Honest failure — no invented numbers or synthesized "directives".
      // Rate-limit failures get their own follow-up line: "nothing was
      // invented to cover for it" implies the agent tried and refused to
      // guess, which is the right framing for a genuine data gap but a
      // misleading one for "the AI service itself is briefly saturated" —
      // agent.py already sends a clean, specific message for a 429
      // (see _call_groq_turn), so this just avoids undercutting it with
      // a mismatched generic tagline underneath.
      const isRateLimited = /rate.?limit/i.test(err.message);
      const followUp = isRateLimited
        ? "This clears up on its own within a few seconds."
        : "Nothing above was invented to cover for it — try rephrasing, naming a specific monitored city, or try again in a moment.";
      const errorMsg = {
        id: (Date.now() + 1).toString(),
        sender: 'agent',
        text: `I couldn't complete that investigation: ${err.message}\n\n${followUp}`,
        retryQuery: isRateLimited ? query.trim() : null,
        // A real number here means Retry Countdown below actually disables
        // the button and counts down instead of just being clickable
        // immediately — retrying inside Groq's own stated wait window
        // would just produce the identical 429 again.
        retryAfterSeconds: err.retryAfterSeconds ?? null,
        time: new Date().toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit'
        })
      };
      setMessages(prev => [...prev, errorMsg]);
    } finally {
      setIsLoading(false);
      setLiveStatus(null);
    }
  };
  const handleCopyMessage = (id, text) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };
  if (!isOpen) return null;
  return <div ref={drawerRef} className="fixed inset-y-0 right-0 z-[1300] w-full sm:w-[500px] bg-app/95 backdrop-blur-2xl border-l border-border shadow-2xl flex flex-col justify-between text-ink font-sans animate-slideLeft">
      {/* Drawer Header */}
      <div className="p-4 border-b border-border bg-app/90 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-orange-500 to-red-500 p-0.5 flex items-center justify-center shadow-md shadow-orange-500/20">
            <div className="w-full h-full bg-app rounded-[10px] flex items-center justify-center">
              <Sparkles className="w-4 h-4 text-orange-400" />
            </div>
          </div>
          <div>
            <h3 className="text-sm font-bold text-ink flex items-center gap-1.5">
              Thermora Intelligence Agent
            </h3>
            <span className="text-[10px] font-mono text-inkfaint flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              Investigates real data, live
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1">
          <button onClick={() => {
          setMessages([{
            id: 'welcome-reset',
            sender: 'agent',
            text: `Session reset for ${activeCity.name}. Ask me anything — I'll investigate before I answer.`,
            time: 'Just now'
          }]);
        }} title="Reset conversation" className="p-1.5 text-inkmuted hover:text-ink rounded-lg hover:bg-surface2 transition-all cursor-pointer">
            <RefreshCw className="w-4 h-4" />
          </button>

          <button onClick={onClose} className="p-1.5 text-inkmuted hover:text-ink rounded-lg hover:bg-surface2 transition-all cursor-pointer" aria-label="Close Agent">
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Quick Prompts Bar */}
      <div className="px-4 py-2.5 bg-app/60 border-b border-border/80 flex gap-2 overflow-x-auto text-[11px] font-medium text-inksoft no-scrollbar [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
        {quickPrompts.map((q, idx) => <button key={idx} onClick={() => handleSendMessage(q)} className="px-3 py-1 rounded-full bg-surface/90 hover:bg-orange-500/20 hover:text-orange-300 border border-border hover:border-orange-500/40 whitespace-nowrap transition-all cursor-pointer shrink-0 font-medium text-inksoft">
            {q}
          </button>)}
      </div>

      {/* Chat Messages Feed */}
      <div className="flex-1 p-4 overflow-y-auto space-y-4 no-scrollbar [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
        {messages.map(msg => {
        const isAgent = msg.sender === 'agent';
        return <div key={msg.id} className={`flex gap-3 ${isAgent ? 'items-start' : 'items-start flex-row-reverse'}`}>
              <div className={`w-7 h-7 rounded-xl flex items-center justify-center shrink-0 mt-0.5 text-xs font-bold ${isAgent ? 'bg-orange-500/20 text-orange-400 border border-orange-500/30 shadow-sm' : 'bg-surface2 text-ink border border-borderstrong'}`}>
                {isAgent ? <Bot className="w-4 h-4" /> : <User className="w-4 h-4" />}
              </div>

              <div className={`${msg.isWelcome ? 'max-w-[94%]' : 'max-w-[88%]'} rounded-2xl p-4 text-xs leading-relaxed group relative ${isAgent ? 'bg-surface/90 border border-border text-ink shadow-md' : 'bg-gradient-to-r from-orange-400 to-amber-400 text-zinc-950 font-bold shadow-md shadow-orange-500/10'}`}>
                {isAgent && msg.isWelcome ? (
                  <WelcomeCard cityName={activeCity.name} />
                ) : isAgent && msg.result ? (
                  <AgentResult result={msg.result} />
                ) : (
                  <div className="whitespace-pre-wrap font-sans space-y-2 prose prose-invert max-w-none text-xs">
                    {msg.text}
                    {msg.retryQuery && (
                      <RetryCountdownButton
                        retryAfterSeconds={msg.retryAfterSeconds}
                        onRetry={() => handleSendMessage(msg.retryQuery)}
                        disabled={isLoading}
                      />
                    )}
                  </div>
                )}

                <div className={`text-[9px] font-mono mt-2.5 flex items-center justify-between ${isAgent ? 'text-inkfaint border-t border-border/80 pt-2' : 'text-zinc-900/70 font-semibold'}`}>
                  <span>{isAgent ? 'Thermora AI' : userSettings.userName}</span>
                  <div className="flex items-center gap-2">
                    {isAgent && <button onClick={() => handleCopyMessage(msg.id, msg.text)} className="hover:text-ink transition-colors p-0.5 cursor-pointer" title="Copy text">
                        {copiedId === msg.id ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                      </button>}
                    <span>{msg.time}</span>
                  </div>
                </div>
              </div>
            </div>;
      })}

        {isLoading && <div className="flex items-center gap-3 p-3.5 bg-app/70 rounded-2xl border border-border text-xs text-orange-300 animate-pulse">
            <div className="w-4 h-4 border-2 border-orange-400 border-t-transparent rounded-full animate-spin" />
            {/* Real progress from the streaming endpoint (see
                handleSendMessage) when available — replaces the old
                purely-cosmetic cycling phrase with what the agent is
                ACTUALLY doing right now (which tool, which city),
                falling back to the cosmetic cycle only before the first
                real event has arrived yet. */}
            <span>{liveStatus || THINKING_PHRASES[thinkingPhraseIdx]}</span>
          </div>}
        <div ref={messagesEndRef} />
      </div>

      {/* Message Input Box */}
      <div className="p-4 border-t border-border bg-app">
        <form onSubmit={e => {
        e.preventDefault();
        handleSendMessage();
      }} className="relative flex items-center">
          <input type="text" placeholder={`Ask about ${activeCity.name} hotspots, work windows, cooling plans...`} value={inputText} onChange={e => setInputText(e.target.value)} className="w-full bg-surface border border-border rounded-2xl pl-4 pr-12 py-3 text-xs text-ink placeholder-inkfaint focus:outline-none focus:border-orange-500 font-sans shadow-inner" />
          <button id="ai-send-message-btn" type="submit" disabled={!inputText.trim() || isLoading} className="absolute right-2 p-2 bg-gradient-to-r from-orange-400 to-amber-400 hover:from-orange-300 hover:to-amber-300 disabled:opacity-30 text-zinc-950 rounded-xl transition-all cursor-pointer shadow-md" aria-label="Send query">
            <Send className="w-3.5 h-3.5 text-zinc-950 font-bold" />
          </button>
        </form>
        <p className="text-[10px] text-inkfaint mt-2 text-center font-mono">
          Every number above came from a real tool call — the agent will say so plainly when something isn't available.
        </p>
      </div>
    </div>;
};