import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Cogdex",
  description: "Cogdex — knowledge + context app",
  icons: {
    icon: "/cogdex-icon.png",
    shortcut: "/cogdex-icon.png",
    apple: "/cogdex-icon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body>
        <header className="site-header">
          <img src="/cogdex-icon.png" alt="Cogdex logo" className="logo" />
        </header>
        {children}
      </body>
    </html>
  );
}
