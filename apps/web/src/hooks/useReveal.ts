import { useEffect, useRef } from "react";

/**
 * Reveal-on-scroll, via IntersectionObserver rather than a scroll listener.
 *
 * The CSS does the animating (`.reveal` → `.reveal-in` in styles.css); this only decides when. Two
 * properties worth keeping:
 *
 *  - **Content is visible without JS.** `.reveal` defaults to `opacity: 1` and only becomes hidden
 *    inside a `prefers-reduced-motion: no-preference` block, so a crawler, a JS failure, or a
 *    reduced-motion user sees the page — never a blank column of invisible sections.
 *  - **It fires once.** Unobserving after reveal means no work on subsequent scrolls, and content
 *    doesn't re-animate when you scroll back up, which reads as a glitch rather than a flourish.
 */
export function useReveal<T extends HTMLElement = HTMLDivElement>(options?: {
  /** How far into the viewport before revealing. Default 12% up from the bottom edge. */
  rootMargin?: string;
}) {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // The hiding class is added HERE, not in the JSX. A statically-classed `.reveal` would be hidden
    // by CSS the moment the stylesheet loads, and would stay hidden forever if this script never ran.
    // Adding it from the effect means "invisible" can only ever be a state JS is present to undo.
    el.classList.add("reveal");

    // No IntersectionObserver (or SSR-hydrated old browser): show it and move on.
    if (typeof IntersectionObserver === "undefined") {
      el.classList.add("reveal-in");
      return;
    }

    // Already in view on load (above the fold) — reveal immediately so the first screen isn't blank
    // for a frame while the observer settles.
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("reveal-in");
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: options?.rootMargin ?? "0px 0px -12% 0px", threshold: 0.05 },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [options?.rootMargin]);

  return ref;
}

/**
 * Reveal a container's direct children as a stagger, setting `--reveal-i` per child.
 *
 * Done here rather than by hand in JSX because the index has to match DOM order, and threading a
 * counter through mapped markup is exactly where that silently drifts.
 */
export function useRevealGroup<T extends HTMLElement = HTMLDivElement>(options?: {
  rootMargin?: string;
  /** Cap the stagger so a long list doesn't take seconds to finish appearing. */
  maxIndex?: number;
}) {
  const ref = useRef<T | null>(null);
  const maxIndex = options?.maxIndex ?? 6;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const children = Array.from(el.children) as HTMLElement[];
    children.forEach((child, i) => {
      child.classList.add("reveal");
      child.style.setProperty("--reveal-i", String(Math.min(i, maxIndex)));
    });

    if (typeof IntersectionObserver === "undefined") {
      children.forEach((c) => c.classList.add("reveal-in"));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          // Reveal the whole group together so the stagger reads as one gesture, not a race between
          // children crossing the threshold at slightly different times.
          children.forEach((c) => c.classList.add("reveal-in"));
          observer.disconnect();
        }
      },
      { rootMargin: options?.rootMargin ?? "0px 0px -10% 0px", threshold: 0.05 },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [options?.rootMargin, maxIndex]);

  return ref;
}
