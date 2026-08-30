// Non-city reference data. The actual monitored-city list is NOT here
// anymore — it now comes live from GET /api/cities (backend/app/locations.py
// is the single source of truth) via hooks/useCities.js, so the frontend
// and backend can never silently drift out of sync on which cities exist.

export const DEFAULT_USER_SETTINGS = {
  userName: '',
  email: '',
  role: '',
  organization: '',
  tempUnit: 'F',
  warningThreshold: 98,
  emergencyThreshold: 104,
  maxWetBulbThreshold: 84,
  persistenceAlertHours: 4,
  notifications: {
    emailAlerts: false,
    smsAlerts: false,
    webhookDispatch: false,
    webhookUrl: '',
    dailyMorningBrief: false,
  },
};

// Small helper: default AOI (roughly a 2.2km box) centered on a city,
// used to seed a heatmap request before the user draws their own AOI.
export function defaultBBoxForCity(city, halfWidthDeg = 0.01) {
  return {
    min_lat: city.lat - halfWidthDeg,
    max_lat: city.lat + halfWidthDeg,
    min_lng: city.lon - halfWidthDeg,
    max_lng: city.lon + halfWidthDeg,
  };
}