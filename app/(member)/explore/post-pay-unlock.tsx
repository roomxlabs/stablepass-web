"use client";

// Stripe 3DS (and any confirm that must leave the page) lands on
// /explore?paid=1. The webhook may not have written yet, so this waits
// for the feed gate then hard-reloads a clean /explore.
import { useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { waitForEntitled } from "@/lib/api/wait-for-access";

export function PostPayUnlock() {
  const paid = useSearchParams().get("paid") === "1";

  useEffect(() => {
    if (!paid) return;
    const ac = new AbortController();
    void waitForEntitled({ signal: ac.signal }).finally(() => {
      if (!ac.signal.aborted) window.location.replace("/explore");
    });
    return () => ac.abort();
  }, [paid]);

  if (!paid) return null;
  return (
    <div className="trial-banner-web" style={{ margin: "0 0 16px" }}>
      <div className="trial-label">Unlocking access</div>
      <div className="trial-detail">Your payment went through. Loading your feed…</div>
    </div>
  );
}
