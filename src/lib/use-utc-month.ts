import { useEffect, useState } from "react";

/** Refresh at the UTC month boundary, and recover after sleeping/backgrounding.
 * The one-minute cap also avoids overflowing the browser's 32-bit timer delay.
 */
export function useUtcMonth() {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const sync = () => {
      clearTimeout(timer);
      const now = new Date();
      setMonth(now.toISOString().slice(0, 7));
      const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
      timer = setTimeout(sync, Math.min(next - now.getTime() + 50, 60_000));
    };
    sync();
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);
  return month;
}
