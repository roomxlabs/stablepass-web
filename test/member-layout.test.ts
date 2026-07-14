import { describe, it, expect, vi } from "vitest";

const redirectMock = vi.hoisted(() =>
  vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
);

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: null } })) },
  })),
}));

import MemberLayout from "@/app/(member)/layout";

describe("MemberLayout", () => {
  it("redirects unauthenticated visitors to /signin", async () => {
    await expect(MemberLayout({ children: null })).rejects.toThrow("REDIRECT:/signin");
    expect(redirectMock).toHaveBeenCalledWith("/signin");
  });
});
