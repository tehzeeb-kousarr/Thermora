// Centralized backend API base URL.
// In dev, Vite proxies /api to the FastAPI backend (see vite.config.js),
// so the default empty string (relative path) works out of the box.
// In production, set VITE_API_URL to your deployed FastAPI URL.
export const API_BASE_URL = import.meta.env.VITE_API_URL || '';

export function apiUrl(path) {
  return `${API_BASE_URL}${path}`;
}
