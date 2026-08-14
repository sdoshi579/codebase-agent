import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "graphify / chat",
  description: "Chat with any public GitHub repository's execution flow.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-void text-ink antialiased">
        {children}
      </body>
    </html>
  );
}
