"use client";

// Reveal-password input (Naufal, 1 Sep 2026) — a drop-in for the bare
// `<input className="input" type="password">` on the sign-in and trial-start
// forms. Visibility is local state; the eye button is aria-labelled for the
// NEXT action and `type="button"` so it can never submit the form.
import { useState, type InputHTMLAttributes } from "react";

function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {off ? (
        <>
          <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24" />
          <path d="M1 1l22 22" />
        </>
      ) : (
        <>
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <circle cx="12" cy="12" r="3" />
        </>
      )}
    </svg>
  );
}

export default function PasswordInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const [revealed, setRevealed] = useState(false);
  const { style, ...rest } = props;
  return (
    <div style={{ position: "relative" }}>
      <input
        {...rest}
        type={revealed ? "text" : "password"}
        style={{ paddingRight: 44, ...style }}
      />
      <button
        type="button"
        aria-label={revealed ? "Hide password" : "Show password"}
        onClick={() => setRevealed((r) => !r)}
        style={{
          position: "absolute",
          right: 0,
          top: 0,
          bottom: 0,
          width: 40,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "none",
          border: "none",
          cursor: "pointer",
          color: "var(--muted, #6b6b6b)",
        }}
      >
        <EyeIcon off={revealed} />
      </button>
    </div>
  );
}
