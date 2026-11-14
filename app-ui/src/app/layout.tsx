import type { Metadata, Viewport } from "next";
import { Fraunces, Inter } from "next/font/google";
import "./(site)/globals.css";
import { Providers } from "./providers";

/* Speckle fonts — the landing (and its Earthquake child page) set them on
   the .speckle-page wrapper via the two CSS variables; the host app keeps
   its own defaults outside that scope. */
const fraunces = Fraunces({
  subsets: ["latin"],
  style: ["normal", "italic"],
  axes: ["opsz"],
  variable: "--font-speckle-display",
  display: "swap",
});

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-speckle-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Speckle · Earth is always changing",
  description:
    "A cinematic journey from orbit into Earth's changing landscapes — and the earthquake investigation room of the Dancing with the SARs hazard engine.",
  keywords: [
    "Speckle",
    "Earth observation",
    "SAR",
    "radar",
    "NASA Space Apps",
    "Dancing with the SARs",
    "hazard engine",
    "InSAR",
    "earthquake",
  ],
  authors: [{ name: "Dancing with the SARs team" }],
  openGraph: {
    siteName: "Speckle",
    type: "website",
    title: "Speckle · Earth is always changing",
    description:
      "A cinematic journey from orbit into Earth's changing landscapes — radar, physics and honest verdicts.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Speckle · Earth is always changing",
    description:
      "A cinematic journey from orbit into Earth's changing landscapes — radar, physics and honest verdicts.",
  },
};

export const viewport: Viewport = {
  themeColor: "#04070d",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${fraunces.variable} ${inter.variable} antialiased bg-[#04070d] text-foreground`}
      >
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
