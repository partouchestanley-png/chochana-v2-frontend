import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        gold: "#C5A35A",
        cream: "#FAF8F3",
        ink: "#1F1A14",
        sub: "#6B655C",
        green: "#2F7A4F",
        greenBg: "#EAF5EE",
        amber: "#B8860B",
        amberBg: "#FFF8E1",
        border: "#E5DFD2",
      },
    },
  },
  plugins: [],
};

export default config;
