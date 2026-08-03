/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        "db-page": "var(--color-db-page)",
        "db-surface": "var(--color-db-surface)",
        "db-elevated": "var(--color-db-elevated)",
        "db-subtle": "var(--color-db-subtle)",
        "db-border": "var(--color-db-border)",
        "db-border-strong": "var(--color-db-border-strong)",
        "db-text": "var(--color-db-text)",
        "db-text-secondary": "var(--color-db-text-secondary)",
        "db-text-tertiary": "var(--color-db-text-tertiary)",
        "db-accent": "var(--color-db-accent)",
        "db-accent-hover": "var(--color-db-accent-hover)",
        "db-success": "var(--color-db-success)",
        "db-warning": "var(--color-db-warning)",
        "db-danger": "var(--color-db-danger)",
        "db-info": "var(--color-db-info)",
      },
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
        mono: [
          "JetBrains Mono",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "Consolas",
          "monospace",
        ],
      },
    },
  },
  plugins: [],
};
