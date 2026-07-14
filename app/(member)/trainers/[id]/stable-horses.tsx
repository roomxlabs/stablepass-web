"use client";

// StableHorses — the "Horses in this stable" grid on the trainer profile. A tiny
// client island so the reused W4 <HorseCard> (callback-driven) can navigate to each
// horse profile. Data comes from the server page (no fetch here).
import { useRouter } from "next/navigation";
import { HorseCard } from "@/components/horse-card";
import type { HorseSummary } from "@/components/types";

export function StableHorses({ horses }: { horses: HorseSummary[] }) {
  const router = useRouter();
  if (horses.length === 0) {
    return <p style={{ color: "var(--muted)", padding: "8px 0 24px" }}>No horses in this stable yet.</p>;
  }
  return (
    <div className="onboarding-grid-web" style={{ marginBottom: 32 }}>
      {horses.map((h) => (
        <HorseCard key={h.id} horse={h} onClick={() => router.push(`/horses/${h.id}`)} />
      ))}
    </div>
  );
}
