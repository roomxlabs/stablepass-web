import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PostHead } from "@/components/post-head";
import type { FeedPost } from "@/components/types";

const BASE: Omit<FeedPost, "subject" | "head" | "byline"> = {
  id: "post-1",
  horseId: "h1",
  horseName: "Mahogany",
  trainerName: "Chris Waller",
  postedAgo: "2h ago",
  label: null,
  media: { type: "photo", posterUrl: null },
  watermarked: false,
  raceBadge: null,
  count: 12,
  reacted: null,
  bookmarked: false,
};

describe("PostHead — horse subject", () => {
  it("h3 is the horse name, line2 leads with the trainer name, and there is NO head link", () => {
    const post: FeedPost = {
      ...BASE,
      subject: "horse",
      horseName: "Winx",
      trainerName: "Chris Waller",
      head: { kind: "horse", name: "Winx", line2: "Chris Waller", avatarUrl: null, href: null },
    };
    render(<PostHead post={post} />);

    expect(screen.getByRole("heading", { level: 3 })).toHaveTextContent("Winx");
    const byline = document.querySelector(".post-byline")!;
    expect(byline.textContent).toContain("Chris Waller");
    expect(screen.queryByTestId("post-head-link")).not.toBeInTheDocument();
  });
});

describe("PostHead — trainer subject", () => {
  it("h3 is the trainer name, line2 has stable · location, the head IS a link to /trainers/<id>, and the horse name is absent", () => {
    const post: FeedPost = {
      ...BASE,
      // Deliberately non-empty and distinctive — proves the trainer head does
      // NOT fall back to the horse name anywhere in the row.
      horseName: "Mahogany",
      trainerName: "Chris Waller",
      subject: "trainer",
      head: {
        kind: "trainer",
        name: "Chris Waller",
        line2: "Waller Racing · Rosehill",
        avatarUrl: null,
        href: "/trainers/trainer-1",
      },
    };
    render(<PostHead post={post} />);

    expect(screen.getByRole("heading", { level: 3 })).toHaveTextContent("Chris Waller");
    const meta = document.querySelector(".post-meta-web")!;
    expect(meta.textContent).toContain("Waller Racing · Rosehill");
    const link = screen.getByTestId("post-head-link");
    expect(link).toHaveAttribute("href", "/trainers/trainer-1");
    expect(meta.textContent).not.toContain("Mahogany");
  });
});

describe("PostHead — stablepass subject", () => {
  it("h3 is the literal lowercase 'stablepass', line2 is the byline, the S-mark renders, there is no link, and the horse name is absent", () => {
    const post: FeedPost = {
      ...BASE,
      horseName: "Mahogany",
      trainerName: "",
      subject: "stablepass",
      byline: "Racing TV",
      head: { kind: "stablepass", name: "stablepass", line2: "Racing TV", avatarUrl: null, href: null },
    };
    render(<PostHead post={post} />);

    const heading = screen.getByRole("heading", { level: 3 });
    expect(heading.textContent).toBe("stablepass");
    const meta = document.querySelector(".post-meta-web")!;
    expect(meta.textContent).toContain("Racing TV");
    expect(meta.textContent).not.toContain("Mahogany");

    const mark = screen.getByTestId("post-head-mark");
    expect(mark).toHaveAttribute("src", "/brand/mark.png");
    expect(screen.queryByTestId("post-head-link")).not.toBeInTheDocument();
  });
});

describe("PostHead — the legacy/untouched-screen path (no head, no subject)", () => {
  it("still renders the horse head, rebuilt from horseName/trainerName", () => {
    const post: FeedPost = {
      ...BASE,
      horseName: "Mahogany",
      trainerName: "Chris Waller",
      // No `subject`, no `head` — exactly what horse-posts.tsx (deliberately
      // untouched by ENG-1270) and a pre-B1 row both look like.
    };
    render(<PostHead post={post} />);

    expect(screen.getByRole("heading", { level: 3 })).toHaveTextContent("Mahogany");
    const byline = document.querySelector(".post-byline")!;
    expect(byline.textContent).toContain("Chris Waller");
    expect(screen.queryByTestId("post-head-link")).not.toBeInTheDocument();
  });
});

describe("PostHead — a null line2 renders the posted-ago text alone", () => {
  it("no leading '·' when line2 is null", () => {
    const post: FeedPost = {
      ...BASE,
      subject: "stablepass",
      byline: null,
      postedAgo: "6h ago",
      head: { kind: "stablepass", name: "stablepass", line2: null, avatarUrl: null, href: null },
    };
    render(<PostHead post={post} />);

    const byline = document.querySelector(".post-byline")!;
    expect(byline.textContent).toBe("6h ago");
    expect(byline.textContent).not.toContain("·");
  });
});
