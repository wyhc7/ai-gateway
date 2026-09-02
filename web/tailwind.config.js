/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{vue,js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        paper: 'var(--paper)',
        surface: 'var(--surface)',
        ink: {
          DEFAULT: 'var(--ink)',
          2: 'var(--ink-2)',
          3: 'var(--ink-3)',
          4: 'var(--ink-4)'
        },
        rule: {
          DEFAULT: 'var(--rule)',
          soft: 'var(--rule-soft)',
          strong: 'var(--rule-strong)'
        },
        accent: {
          DEFAULT: 'var(--accent)',
          soft: 'var(--accent-soft)',
          tint: 'var(--accent-tint)'
        }
      },
      fontFamily: {
        sans: [
          'IBM Plex Sans', 'PingFang SC', 'HarmonyOS Sans SC',
          'Source Han Sans SC', 'Noto Sans CJK SC', 'Microsoft YaHei',
          'system-ui', 'sans-serif'
        ],
        mono: [
          'IBM Plex Mono', 'JetBrains Mono', 'SFMono-Regular',
          'Cascadia Mono', 'Menlo', 'Consolas', 'Liberation Mono', 'monospace'
        ]
      }
    }
  },
  plugins: []
}
