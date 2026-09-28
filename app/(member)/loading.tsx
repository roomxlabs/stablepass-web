// Member-route loading state (ENG-1593).
//
// With this file Next streams the member SHELL — the sidebar and the frame the
// layout renders — the moment the layout is done, and fills the content area
// with the skeleton until the page's own data resolves. Before it there was no
// loading boundary anywhere under `app/`, so the browser received nothing at
// all until every await on the page had finished.
//
// The auth redirect is unaffected: it happens in `./layout.tsx`, which sits
// ABOVE this boundary, so a signed-out visitor still gets a real 307 before
// any HTML is streamed.
//
// Trade-off, known and accepted: a page BELOW this boundary that calls
// `notFound()` (a hidden horse or trainer) now renders the not-found UI with a
// noindex tag inside an already-started 200 response instead of an HTTP 404 —
// the status line is sent before the page's data exists. The member space is
// noindex already, and the BFF's 404 contract (`app/api/*`) is untouched.
import { FeedSkeleton } from "./feed-skeleton";

export default function MemberLoading() {
  return <FeedSkeleton />;
}
