import { useEffect, useState } from 'react';
import { fetchStatus } from '../api/thermoraApi';

// Polls the backend's /api/status every intervalMs. Distinguishes:
//  - "live": FortyGuard has responded successfully and isn't currently erroring
//  - "degraded": has worked before, but recent calls are failing
//  - "down": every call so far has failed
//  - "unknown": no calls made yet (fresh backend process)
//  - "unreachable": couldn't even reach OUR backend (not FortyGuard's fault)
export function useApiStatus(intervalMs = 5000) {
  const [status, setStatus] = useState({ state: 'unknown', detail: null });

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const data = await fetchStatus();
        if (!cancelled) setStatus({ state: data.fortyguard_status, detail: data });
      } catch (err) {
        if (!cancelled) setStatus({ state: 'unreachable', detail: { error: err.message } });
      }
    };

    poll();
    const id = setInterval(poll, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [intervalMs]);

  return status;
}
