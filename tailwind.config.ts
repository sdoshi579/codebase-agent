import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        void: "#0A0C0F",
        panel: "#10131A",
        panelRaised: "#161A22",
        line: "#1F252E",
        lineBright: "#2A3140",
        ink: "#E7E9EA",
        inkMuted: "#8B93A1",
        inkFaint: "#565E6C",
        graft: "#3FB950",
        graftDim: "#1F4A2A",
        wire: "#58A6FF",
        wireDim: "#1B3A5C",
        amber: "#D29922",
        sever: "#F85149",
      },
      fontFamily: {
        mono: ["'JetBrains Mono'", "'IBM Plex Mono'", "ui-monospace", "monospace"],
        body: ["'Inter'", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      keyframes: {
        blink: {
          "0%, 49%": { opacity: "1" },
          "50%, 100%": { opacity: "0" },
        },
        scanline: {
          "0%": { transform: "translateY(-100%)" },
          "100%": { transform: "translateY(100%)" },
        },
        fadeUp: {
          "0%": { opacity: "0", transform: "translateY(6px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        blink: "blink 1s step-end infinite",
        scanline: "scanline 2.4s linear infinite",
        fadeUp: "fadeUp 0.25s ease-out",
      },
    },
  },
  plugins: [],
};

export default config;
