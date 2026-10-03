/**
 * Calls `onVisible` whenever `target` is in view (infinite scroll for the Models and History lists). An
 * IntersectionObserver reports only changes, so after the list grew and the sentinel is still in view call
 * `recheck()`: it observes again, which reports the current state at once. Browsers without
 * IntersectionObserver never call `onVisible`; the "Show more" button next to the sentinel works either way.
 */
export interface VisibilityWatch {
  recheck(): void;
  stop(): void;
}

export function whenVisible(target: Element, onVisible: () => void): VisibilityWatch {
  if (typeof IntersectionObserver === 'undefined') {
    return { recheck: () => undefined, stop: () => undefined };
  }
  const observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) onVisible();
    },
    { rootMargin: '400px 0px' },
  );
  observer.observe(target);
  return {
    recheck: () => {
      observer.unobserve(target);
      observer.observe(target);
    },
    stop: () => observer.disconnect(),
  };
}
