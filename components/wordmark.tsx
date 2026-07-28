// Brand marks. The real logo ships as a single alpha PNG per shape (public/brand/*)
// and is painted with `background-color: currentColor` through a CSS mask, so ONE
// asset serves every colourway — green on cream in the sidebar, cream on green in
// the auth panel — and inherits whatever colour its context sets. That's why there
// is no -white/-green pair to keep in sync.
//
// Size comes from `--wordmark-h` on the parent (the mask is `contain`, so width
// follows from the aspect-ratio in globals.css). The literal text stays in the DOM,
// visually hidden, so the brand name is still announced and still greppable.

function srText() {
  return <span className="sr-only">stablepass.</span>;
}

/** Full "stablepass." wordmark. */
export function Wordmark({ className }: { className?: string }) {
  return <span className={className ? `wordmark ${className}` : "wordmark"}>{srText()}</span>;
}

/** Square "S." mark — used where the full wordmark doesn't fit (collapsed rail). */
export function BrandMark({ className }: { className?: string }) {
  return <span className={className ? `brandmark ${className}` : "brandmark"}>{srText()}</span>;
}
