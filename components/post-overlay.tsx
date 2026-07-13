// post-overlay — the brand watermark + a faint forensic viewer-id, drawn OVER the
// media/player. Deterrence only: the underlying Mux/Storage asset is NEVER modified
// (this is a DOM layer above it). The viewer-id is the signed-in user's own id/hash —
// no extra PII. Consistent with the mobile M3 post-overlay.
export function PostOverlay({ viewerId }: { viewerId: string }) {
  // Short, uppercased tag — enough to trace a leaked screenshot back to an account
  // without splashing a full uuid across the frame.
  const tag = `SP·${viewerId.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
  return (
    <div className="post-overlay" aria-hidden="true" data-testid="post-overlay">
      <span className="viewer-id">{tag}</span>
      <span className="brand-mark">stablepass.</span>
    </div>
  );
}
