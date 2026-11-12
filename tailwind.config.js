const token = (name) => `rgb(var(--${name}) / <alpha-value>)`

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        canvas: token('bg'),
        panel: token('panel'),
        raised: token('panel2'),
        line: token('line'),
        ink: token('fg'),
        mute: token('muted'),
        accent: token('accent'),
        accent2: token('accent2'),
        'accent-ink': token('accent-fg'),
        up: token('up'),
        down: token('down'),
        warn: token('warn'),
      },
      fontFamily: {
        display: ['"Space Grotesk"', 'sans-serif'],
        sans: ['"DM Sans"', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
}
