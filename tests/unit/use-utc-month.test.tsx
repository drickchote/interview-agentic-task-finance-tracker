import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useUtcMonth } from "#/lib/use-utc-month";

afterEach(() => {
  vi.useRealTimers();
});

it("switches query month at a UTC year boundary and cleans up its timer", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-12-31T23:59:59Z"));
  const { result, unmount } = renderHook(() => useUtcMonth());
  expect(result.current).toBe("2026-12");
  act(() => {
    vi.advanceTimersByTime(1100);
  });
  expect(result.current).toBe("2027-01");
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("recovers the month on focus after the browser has slept", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-15T12:00:00Z"));
  const { result, unmount } = renderHook(() => useUtcMonth());
  act(() => {
    vi.setSystemTime(new Date("2026-12-01T00:00:00Z"));
    window.dispatchEvent(new Event("focus"));
  });
  expect(result.current).toBe("2026-12");
  unmount();
});
