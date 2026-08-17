import "@testing-library/jest-dom/vitest";

/**
 * jsdom ships no `window.matchMedia` (ENG-589 / W3).
 *
 * The trainer marquee asks it for `(hover: none)` and
 * `(prefers-reduced-motion: reduce)` on mount to pick its input mode, so
 * without this every test that renders the marketing home throws before it
 * asserts anything. Guarding the call in the component instead would put a
 * branch in shipped code that exists only for the test runner.
 *
 * The default answers "no" to everything, which is the hover-capable,
 * full-motion desktop. A test that needs another mode stubs `matchMedia`
 * itself — see `test/marketing-sheets.test.tsx`.
 */
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
