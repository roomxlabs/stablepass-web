"use client";

// AccountForms — the interactive half of the Account screen (09-account.html
// MINUS Devices & sessions — single-device guardrail, .rx/guardrails.md #5).
// Profile edits + notification toggles both PATCH the /api/me BFF route (never
// a direct table write — `is_admin`/`email` aren't in the PATCH allow-list
// there); toggles are optimistic and revert on error, mirroring the
// follow-notify.tsx pattern. Sign out reuses the sidebar's supabaseBrowser
// signOut → /signin flow (this is the ONLY sign-out surface on this card — no
// "sign out everywhere").
import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";

export interface AccountSubscriber {
  name: string;
  email: string;
  phone: string;
}

export interface AccountPrefs {
  newPost: boolean;
  raceDay: boolean;
  raceResult: boolean;
  milestone: boolean;
}

const NOTIF_TOGGLES: { key: keyof AccountPrefs; title: string; sub: string }[] = [
  { key: "newPost", title: "New posts", sub: "Updates from horses and trainers in your push list" },
  { key: "raceDay", title: "Race day", sub: "Get notified 2 hours before any followed horse races" },
  { key: "raceResult", title: "Race results", sub: "Find out how your horses ran, even if you missed it live" },
  { key: "milestone", title: "Milestones", sub: "First wins, retirements, and other big moments" },
];

async function patchMe(body: unknown) {
  return fetch("/api/me", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function AccountForms({
  initialSubscriber,
  initialPrefs,
}: {
  initialSubscriber: AccountSubscriber;
  initialPrefs: AccountPrefs;
}) {
  const router = useRouter();

  const [name, setName] = useState(initialSubscriber.name);
  const [phone, setPhone] = useState(initialSubscriber.phone);
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileSaved, setProfileSaved] = useState(false);

  const [prefs, setPrefs] = useState<AccountPrefs>(initialPrefs);
  const [prefsError, setPrefsError] = useState(false);

  async function onSaveProfile(e: React.FormEvent) {
    e.preventDefault();
    setSavingProfile(true);
    setProfileError(null);
    setProfileSaved(false);
    const res = await patchMe({ name, phone });
    if (res.ok) {
      setProfileSaved(true);
    } else {
      const body = await res.json().catch(() => null);
      setProfileError(body?.error?.message ?? "Couldn't save your changes.");
    }
    setSavingProfile(false);
  }

  async function togglePref(key: keyof AccountPrefs) {
    const prevValue = prefs[key];
    const nextValue = !prevValue;
    setPrefsError(false);
    setPrefs((p) => ({ ...p, [key]: nextValue }));
    const res = await patchMe({ prefs: { [key]: nextValue } });
    if (!res.ok) {
      setPrefs((p) => ({ ...p, [key]: prevValue }));
      setPrefsError(true);
    }
  }

  async function signOut() {
    await supabaseBrowser().auth.signOut();
    router.push("/signin");
    router.refresh();
  }

  return (
    <>
      <div className="settings-card">
        <div className="settings-card-head">
          <div>
            <h3>Profile</h3>
            <div className="sub">Your details - only visible to you</div>
          </div>
        </div>
        <form onSubmit={onSaveProfile} style={{ padding: "22px 26px 26px" }}>
          <div className="input-group">
            <label className="input-label" htmlFor="account-name">Name</label>
            <input
              id="account-name"
              className="input"
              type="text"
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="input-group">
            <label className="input-label" htmlFor="account-phone">Phone</label>
            <input
              id="account-phone"
              className="input"
              type="tel"
              autoComplete="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>
          <div className="settings-row" style={{ padding: "0 0 14px" }}>
            <span className="label">Email</span>
            <span className="value">{initialSubscriber.email}</span>
          </div>
          <div className="settings-row" style={{ padding: "0 0 20px", borderBottom: "none" }}>
            <span className="label">Password</span>
            <span className="value">
              •••••••••{" "}
              <a href="/forgot-password" style={{ marginLeft: 8, fontSize: 12, color: "var(--brand-green)" }}>
                Change password
              </a>
            </span>
          </div>

          {profileError && <div className="form-error" role="alert">{profileError}</div>}
          {profileSaved && !profileError && (
            <p style={{ color: "var(--brand-green)", fontSize: 13.5, margin: "0 0 14px" }}>Saved.</p>
          )}

          <button type="submit" className="btn btn-primary" disabled={savingProfile}>
            {savingProfile ? "Saving…" : "Save"}
          </button>
        </form>
      </div>

      <div className="settings-card">
        <div className="settings-card-head">
          <div>
            <h3>Notifications</h3>
            <div className="sub">Notification types you&rsquo;d like to receive</div>
          </div>
        </div>
        {prefsError && (
          <p role="alert" style={{ margin: 0, padding: "12px 26px 0", color: "var(--red)", fontSize: 12.5 }}>
            Couldn&rsquo;t save that change — please try again.
          </p>
        )}
        {NOTIF_TOGGLES.map(({ key, title, sub }) => (
          <div key={key} className="settings-row notif-row">
            <div>
              <div className="notif-title">{title}</div>
              <div className="notif-sub">{sub}</div>
            </div>
            <button
              type="button"
              className={`toggle${prefs[key] ? " on" : ""}`}
              style={{ border: "none", padding: 0 }}
              role="switch"
              aria-checked={prefs[key]}
              aria-label={title}
              onClick={() => togglePref(key)}
            />
          </div>
        ))}
      </div>

      <div style={{ textAlign: "center", padding: "24px 0 40px" }}>
        <button
          type="button"
          onClick={signOut}
          className="btn btn-light"
          style={{ color: "var(--red)", borderColor: "var(--line)" }}
        >
          Sign out
        </button>
      </div>
    </>
  );
}
