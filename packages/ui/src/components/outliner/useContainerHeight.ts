import { useCallback, useEffect, useState } from 'react';

/**
 * Track the rendered height of a container so a virtualized tree can size
 * itself to its parent. Uses `ResizeObserver`; safe to mount in SSR-disabled
 * React trees.
 *
 * Uses a callback ref backed by state so the observer is (re)attached the
 * moment the measured div actually enters the DOM — including when the
 * surrounding component flips out of a loading/empty branch and mounts the
 * div later. A plain ref + empty-deps effect would bail once while the div
 * is absent and never measure again (height locked at 0).
 */
export function useContainerHeight() {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (!el) return;
    const measure = () =>
      setSize({ width: el.clientWidth, height: el.clientHeight });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [el]);

  const containerRef = useCallback((node: HTMLDivElement | null) => {
    setEl(node);
  }, []);

  return { containerRef, width: size.width, height: size.height };
}
