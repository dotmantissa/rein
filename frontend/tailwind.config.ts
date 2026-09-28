import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        rein: {
          red: "#eb1700",
          dark: "#191919",
          surface: "#1f1f1f",
          border: "#2a2a2a",
          "border-light": "#e5e5e5",
          white: "#ffffff",
        },
        status: {
          compliant: "#22c55e",
          flagged: "#f59e0b",
          breach: "#eb1700",
          ambiguous: "#8b5cf6",
        },
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', "monospace"],
        sans: ['"Inter"', "system-ui", "sans-serif"],
      },
      animation: {
        "verdict-wipe": "verdictWipe 0.3s ease-out forwards",
        "revoke-flood": "revokeFlood 0.3s ease-out forwards",
      },
      keyframes: {
        verdictWipe: {
          "0%": { clipPath: "inset(0 100% 0 0)" },
          "100%": { clipPath: "inset(0 0 0 0)" },
        },
        revokeFlood: {
          "0%": { backgroundPosition: "-100% 0" },
          "100%": { backgroundPosition: "0 0" },
        },
      },
    },
  },
  plugins: [],
};
export default config;
