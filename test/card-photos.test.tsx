import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { HorseCard } from "@/components/horse-card";
import { TrainerCard } from "@/components/trainer-card";

// Adversarial-review follow-up (ENG-1057): both cards now key their fallback on
// the URL that failed (`failedUrl`), not a bare boolean — see the block comment
// in horse-card.tsx. A latching boolean strands a REUSED card instance (grids
// key by id) on its initial forever, even once a fresh signed url arrives for
// the same row. These cases render, fail the FIRST url, confirm the fallback,
// then `rerender` the SAME instance with a DIFFERENT url and assert the photo
// comes back — this is the regression the fix exists for, and it must fail if
// someone reverts to a boolean latch.

// ENG-1057 — unit-level coverage of the two card components' photo-or-initial
// branch, direct: no supabase mock needed, because these components never
// sign anything themselves (they render a URL a screen already signed). See
// lib/storage/photos.ts for the signing rule these fixtures assume held.

const HORSE = { id: "h1", name: "Mahogany", trainerName: "Chris Waller" };
const TRAINER = { id: "t1", name: "Chris Waller", horseCount: 3 };

describe("HorseCard — photo-or-initial thumb (ENG-1057)", () => {
  it("with photoUrl set, renders an <img> with that src and class horse-thumb-photo; no initial", () => {
    render(<HorseCard horse={{ ...HORSE, photoUrl: "https://sb.test/signed/mahogany.jpg" }} />);

    const img = screen.getByRole("button").querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("src", "https://sb.test/signed/mahogany.jpg");
    expect(img).toHaveClass("horse-thumb-photo");
    // Only ONE "M" is possible from the name itself; the thumb's own fallback
    // glyph must not also be in the document.
    expect(screen.queryByText("M")).not.toBeInTheDocument();
  });

  it("with photoUrl: null, renders the initial and no <img>", () => {
    render(<HorseCard horse={{ ...HORSE, photoUrl: null }} />);

    expect(screen.getByText("M")).toBeInTheDocument();
    expect(screen.getByRole("button").querySelector("img")).toBeNull();
  });

  it("with photoUrl absent entirely, renders the initial and no <img>", () => {
    render(<HorseCard horse={{ ...HORSE }} />);

    expect(screen.getByText("M")).toBeInTheDocument();
    expect(screen.getByRole("button").querySelector("img")).toBeNull();
  });

  it("firing the img's error event drops the photo and falls back to the initial", () => {
    render(<HorseCard horse={{ ...HORSE, photoUrl: "https://sb.test/signed/mahogany.jpg" }} />);

    const img = screen.getByRole("button").querySelector("img")!;
    fireEvent.error(img);

    expect(screen.getByRole("button").querySelector("img")).toBeNull();
    expect(screen.getByText("M")).toBeInTheDocument();
  });

  it("REGRESSION: a fresh url for the SAME reused card recovers from a prior failure (keyed on failedUrl, not a boolean)", () => {
    const { rerender } = render(
      <HorseCard horse={{ ...HORSE, photoUrl: "https://sb.test/signed/mahogany-A.jpg" }} />,
    );

    const imgA = screen.getByRole("button").querySelector("img")!;
    fireEvent.error(imgA);

    // The failure fell back to the initial, as above.
    expect(screen.getByRole("button").querySelector("img")).toBeNull();
    expect(screen.getByText("M")).toBeInTheDocument();

    // Same component instance (no unmount/remount — this is what a grid keyed
    // by `h.id` does when a fresh signed url lands for the same row), now with
    // a DIFFERENT url. A boolean `failed` latch would stay stuck on the
    // initial forever; keying on the url itself must let this one through.
    rerender(<HorseCard horse={{ ...HORSE, photoUrl: "https://sb.test/signed/mahogany-B.jpg" }} />);

    const imgB = screen.getByRole("button").querySelector("img");
    expect(imgB).not.toBeNull();
    expect(imgB).toHaveAttribute("src", "https://sb.test/signed/mahogany-B.jpg");
    expect(imgB).toHaveClass("horse-thumb-photo");
    expect(screen.queryByText("M")).not.toBeInTheDocument();
  });
});

describe("TrainerCard — photo-or-initials avatar (ENG-1057)", () => {
  it("with photoUrl set, renders an <img> with that src and class trainer-avatar-mini-photo; no initials", () => {
    render(<TrainerCard trainer={{ ...TRAINER, photoUrl: "https://sb.test/signed/waller.jpg" }} />);

    const img = document.querySelector(".trainer-avatar-mini")!.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("src", "https://sb.test/signed/waller.jpg");
    expect(img).toHaveClass("trainer-avatar-mini-photo");
    expect(screen.queryByText("CW")).not.toBeInTheDocument();
  });

  it("with photoUrl: null, renders the two-letter initials and no <img>", () => {
    render(<TrainerCard trainer={{ ...TRAINER, photoUrl: null }} />);

    expect(screen.getByText("CW")).toBeInTheDocument();
    expect(document.querySelector(".trainer-avatar-mini")!.querySelector("img")).toBeNull();
  });

  it("with photoUrl absent entirely, renders the two-letter initials and no <img>", () => {
    render(<TrainerCard trainer={{ ...TRAINER }} />);

    expect(screen.getByText("CW")).toBeInTheDocument();
    expect(document.querySelector(".trainer-avatar-mini")!.querySelector("img")).toBeNull();
  });

  it("firing the img's error event drops the photo and falls back to the initials", () => {
    render(<TrainerCard trainer={{ ...TRAINER, photoUrl: "https://sb.test/signed/waller.jpg" }} />);

    const avatar = document.querySelector(".trainer-avatar-mini")!;
    const img = avatar.querySelector("img")!;
    fireEvent.error(img);

    expect(avatar.querySelector("img")).toBeNull();
    expect(screen.getByText("CW")).toBeInTheDocument();
  });

  it("REGRESSION: a fresh url for the SAME reused card recovers from a prior failure (keyed on failedUrl, not a boolean)", () => {
    const { rerender } = render(
      <TrainerCard trainer={{ ...TRAINER, photoUrl: "https://sb.test/signed/waller-A.jpg" }} />,
    );

    const avatarA = document.querySelector(".trainer-avatar-mini")!;
    fireEvent.error(avatarA.querySelector("img")!);

    expect(avatarA.querySelector("img")).toBeNull();
    expect(screen.getByText("CW")).toBeInTheDocument();

    // Same instance, a DIFFERENT url — models the aside/roster reusing the same
    // <TrainerCard> across a re-render with a freshly signed url.
    rerender(<TrainerCard trainer={{ ...TRAINER, photoUrl: "https://sb.test/signed/waller-B.jpg" }} />);

    const avatarB = document.querySelector(".trainer-avatar-mini")!;
    const imgB = avatarB.querySelector("img");
    expect(imgB).not.toBeNull();
    expect(imgB).toHaveAttribute("src", "https://sb.test/signed/waller-B.jpg");
    expect(imgB).toHaveClass("trainer-avatar-mini-photo");
    expect(screen.queryByText("CW")).not.toBeInTheDocument();
  });
});
