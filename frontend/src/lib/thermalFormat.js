// Shared formatting helpers so every view converts/rounds temperature the
// same way instead of each component reinventing (and subtly disagreeing on) it.

export function cToF(celsius) {
  return celsius == null || Number.isNaN(celsius) ? null : (celsius * 9) / 5 + 32;
}

export function fToC(fahrenheit) {
  return fahrenheit == null || Number.isNaN(fahrenheit) ? null : ((fahrenheit - 32) * 5) / 9;
}

// Converts a raw Celsius value (what FortyGuard always returns) into the
// user's chosen display unit, without mutating the underlying data.
export function displayTemp(celsius, unit = 'F') {
  if (celsius == null || Number.isNaN(celsius)) return null;
  return unit === 'F' ? cToF(celsius) : celsius;
}

export function formatTemp(celsius, unit = 'F', decimals = 1) {
  const v = displayTemp(celsius, unit);
  return v == null ? '—' : `${v.toFixed(decimals)}°${unit}`;
}

export function formatNumber(value, decimals = 1, suffix = '') {
  if (value == null || Number.isNaN(value)) return '—';
  return `${Number(value).toFixed(decimals)}${suffix}`;
}

// Formats a raw analytic-mode value with the RIGHT unit for that mode —
// 'temp' (uses the caller's chosen °F/°C display preference, same as
// formatTemp above), 'hrs' (exceedance/persistence — always plain hours,
// independent of the temperature-unit preference, since these aren't a
// temperature at all), or 'hour' (time_of_measure's UTC hour-of-day).
// Shared by HeatMapView and TimeCompareView so a mode's display format is
// defined in exactly one place rather than each view reimplementing (and
// risking disagreeing on) the same temp-vs-hrs-vs-hour branching.
export function formatAnalyticValue(modeUnit, value, tempUnit = 'F') {
  if (value == null || Number.isNaN(value)) return '—';
  if (modeUnit === 'temp') return formatTemp(value, tempUnit, 1);
  if (modeUnit === 'hour') return `${formatNumber(value, 1)}h`;
  return `${formatNumber(value, 1)} hrs`;
}