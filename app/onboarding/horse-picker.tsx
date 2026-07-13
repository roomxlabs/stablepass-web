"use client";

// Onboarding horse picker (05-onboarding.html). Pick ≥2 horses to follow, with a
// Select-all shortcut; Continue is disabled under 2. On Continue we insert one
// `follow` row per selected horse via the browser client — RLS (`follow_rw_self`,
// user_id = auth.uid()) keeps them user-owned — then land on Explore.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";

export type PickHorse = { id: string; name: string; trainer: string };

const MIN = 2;
const Check = () => (
  <svg className="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 5 5L20 7" /></svg>
);

export function HorsePicker({ horses, userId }: { horses: PickHorse[]; userId: string }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allSelected = horses.length > 0 && selected.size === horses.length;
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const selectAll = () =>
    setSelected((s) => (s.size === horses.length ? new Set() : new Set(horses.map((h) => h.id))));

  async function onContinue() {
    if (selected.size < MIN) return;
    setBusy(true);
    setError(null);
    // One follow row per selected horse (trainer_id null; RLS follow_rw_self keeps
    // them user-owned). Plain insert — first-run onboarding; the follow unique
    // constraint treats null trainer_id as distinct so upsert-dedupe wouldn't apply.
    const rows = [...selected].map((horse_id) => ({ user_id: userId, horse_id }));
    const { error } = await supabaseBrowser().from("follow").insert(rows);
    if (error) {
      setError("Couldn't save your picks — please try again.");
      setBusy(false);
      return;
    }
    router.push("/explore");
    router.refresh();
  }

  return (
    <>
      <div className="onboarding-topline">
        <div className="onboarding-progress">Step 1 of 2</div>
        <button type="button" className="select-all-btn" onClick={selectAll} disabled={horses.length === 0}>
          {allSelected ? "Clear all" : "Select all"}
        </button>
      </div>
      <h1 className="onboarding-h">Build your stable.</h1>
      <p className="onboarding-sub">
        Pick the horses you&rsquo;d like to follow. You can always change this later from your account.
      </p>

      {error && <div className="form-error" role="alert">{error}</div>}

      <div className="onboarding-grid-web">
        {horses.map((h) => {
          const isSel = selected.has(h.id);
          return (
            <button
              key={h.id}
              type="button"
              className={`horse-card-web${isSel ? " selected" : ""}`}
              aria-pressed={isSel}
              onClick={() => toggle(h.id)}
            >
              <div className="horse-thumb" aria-hidden="true">{h.name[0]?.toUpperCase() ?? "?"}</div>
              <div className="horse-name">{h.name}</div>
              <div className="horse-trainer">{h.trainer}</div>
              <div className="check">{isSel && <Check />}</div>
            </button>
          );
        })}
      </div>

      <div className="onboarding-foot-web">
        <div className="count">
          {selected.size} selected · {MIN} minimum to continue
        </div>
        <button
          type="button"
          className="btn btn-primary btn-large"
          style={{ padding: "14px 32px" }}
          onClick={onContinue}
          disabled={selected.size < MIN || busy}
        >
          {busy ? "Saving…" : "Continue →"}
        </button>
      </div>
    </>
  );
}
