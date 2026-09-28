import type { Metadata } from "next";
import { Cormorant_Garamond, Inter, Playfair_Display } from "next/font/google";
import "./globals.css";

// ENG-1593 — VARIABLE fonts, no `weight` list. Every one of these three families
// ships as a variable font on Google Fonts, and next/font self-hosts ONE file per
// style + subset for a variable font instead of one file per weight. The static
// lists this replaced (Cormorant 4 weights x 2 styles, Inter 5, Playfair 2) made
// every member page preload ~15 font files ahead of its first card; now it is 3
// for the families every page uses, and every weight the CSS asks for still
// renders from the same file, so nothing on screen changes.
const cormorant = Cormorant_Garamond({
  variable: "--font-cormorant",
  subsets: ["latin"],
  style: ["normal", "italic"],
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

// Closest live face to the wordmark PNG (high-contrast Didone). Used on the
// /signin and /start h1s — the logo itself is a drawing, not a webfont.
// `preload: false` (ENG-1593): those two h1s are its ONLY use, so preloading it
// on every page — the member feed included — spent a request on a face the page
// never draws. The @font-face stays; those two pages fetch it when they use it.
const playfair = Playfair_Display({
  variable: "--font-playfair",
  subsets: ["latin"],
  preload: false,
});

export const metadata: Metadata = {
  title: "StablePass",
  description: "Behind-the-scenes access to the horses you follow.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${cormorant.variable} ${inter.variable} ${playfair.variable}`}>
      <body>{children}</body>
    </html>
  );
}
