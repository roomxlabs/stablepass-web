"use client";

// follow-notify — the trainer-profile Follow/Notify buttons. Trainer-level: `follow`
// (RLS follow_rw_self) toggles Follow/Following; `notify_optin` (RLS notify_rw_self)
// toggles Notify — for a trainer this means push for every horse in their stable.
// Both writes are user_id = auth.uid()-scoped, exactly one target (trainer_id, with
// horse_id null), and optimistic. Mirrors the W7 horse follow-notify.
import { useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";

const Heart = ({ filled }: { filled: boolean }) => (
  <svg className="ic" viewBox="0 0 24 24" aria-hidden="true" style={filled ? { fill: "currentColor" } : undefined}>
    <path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.5-7 10-7 10Z" />
  </svg>
);
const Bell = ({ filled }: { filled: boolean }) => (
  <svg className="ic" viewBox="0 0 24 24" aria-hidden="true" style={filled ? { fill: "currentColor" } : undefined}>
    <path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z" />
    <path d="M10 20a2 2 0 0 0 4 0" />
  </svg>
);

export interface FollowNotifyProps {
  trainerId: string;
  userId: string;
  initialFollowing: boolean;
  initialNotify: boolean;
}

const notifyOnStyle = { background: "var(--brand-green-soft)", color: "var(--brand-green)", borderColor: "var(--brand-green-soft)" };

export function FollowNotify({ trainerId, userId, initialFollowing, initialNotify }: FollowNotifyProps) {
  const [following, setFollowing] = useState(initialFollowing);
  const [notify, setNotify] = useState(initialNotify);
  const [busyFollow, setBusyFollow] = useState(false);
  const [busyNotify, setBusyNotify] = useState(false);

  async function toggleFollow() {
    const next = !following;
    setFollowing(next);
    setBusyFollow(true);
    const sb = supabaseBrowser();
    const { error } = next
      ? await sb.from("follow").insert({ user_id: userId, trainer_id: trainerId })
      : await sb.from("follow").delete().eq("user_id", userId).eq("trainer_id", trainerId);
    if (error) setFollowing(!next);
    setBusyFollow(false);
  }

  async function toggleNotify() {
    const next = !notify;
    setNotify(next);
    setBusyNotify(true);
    const sb = supabaseBrowser();
    const { error } = next
      ? await sb.from("notify_optin").insert({ user_id: userId, trainer_id: trainerId })
      : await sb.from("notify_optin").delete().eq("user_id", userId).eq("trainer_id", trainerId);
    if (error) setNotify(!next);
    setBusyNotify(false);
  }

  return (
    <div className="profile-actions-web">
      <button type="button" className="btn btn-primary" onClick={toggleFollow} disabled={busyFollow} aria-pressed={following}>
        <Heart filled={following} /> {following ? "Following" : "Follow"}
      </button>
      <button
        type="button"
        className="btn btn-light"
        style={notify ? notifyOnStyle : undefined}
        onClick={toggleNotify}
        disabled={busyNotify}
        aria-pressed={notify}
      >
        <Bell filled={notify} /> {notify ? "Notify on" : "Notify"}
      </button>
    </div>
  );
}
