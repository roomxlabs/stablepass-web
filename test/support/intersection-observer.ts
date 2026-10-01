// A recording IntersectionObserver for jsdom (which ships none). Every observer
// the code under test constructs is kept, with its callback, options and the
// elements it observes, so a test can fire "this element came into view"
// through exactly the observers watching that element (ENG-1633).
import { act } from "@testing-library/react";

type Entry = { target: Element; isIntersecting: boolean; intersectionRatio: number };
type Callback = (entries: Entry[]) => void;

export class MockIntersectionObserver {
  static all: MockIntersectionObserver[] = [];
  readonly targets = new Set<Element>();
  disconnected = false;
  constructor(
    readonly cb: Callback,
    readonly options?: IntersectionObserverInit,
  ) {
    MockIntersectionObserver.all.push(this);
  }
  observe(el: Element) {
    this.targets.add(el);
  }
  unobserve(el: Element) {
    this.targets.delete(el);
  }
  disconnect() {
    this.disconnected = true;
    this.targets.clear();
  }
  takeRecords() {
    return [];
  }
}

/** Install the mock; returns a restore function. Clears prior instances. */
export function installIntersectionObserver(): () => void {
  const original = globalThis.IntersectionObserver;
  MockIntersectionObserver.all = [];
  globalThis.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver;
  return () => {
    globalThis.IntersectionObserver = original;
    MockIntersectionObserver.all = [];
  };
}

/** Observers that have not been disconnected. */
export function liveObservers(): MockIntersectionObserver[] {
  return MockIntersectionObserver.all.filter((o) => !o.disconnected);
}

/**
 * Fire an entry for `target` through every LIVE observer watching it.
 * Returns how many observers it reached.
 */
export function intersect(target: Element, ratio = 1, isIntersecting = ratio > 0): number {
  const watching = liveObservers().filter((o) => o.targets.has(target));
  act(() => {
    for (const o of watching) o.cb([{ target, isIntersecting, intersectionRatio: ratio }]);
  });
  return watching.length;
}
