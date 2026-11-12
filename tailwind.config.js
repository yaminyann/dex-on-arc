const token = (name) => `rgb(var(--${name}) / <alpha-value>)`

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    // Square corners are the identity. Only `full` stays round, for token images and the status dot.
    borderRadius: { none: '0', sm: '0', DEFAULT: '0', md: '0', lg: '0', xl: '0', '2xl': '0', '3xl': '0', full: '9999px' },
    // Every border is a thin 1px line unless a class says otherwise.
    borderWidth: { DEFAULT: '1px', 0: '0', 1: '1px', 2: '2px', 3: '3px', 4: '4px', 8: '8px' },
    extend: {
      colors: {
        canvas: token('bg'),
        panel: token('panel'),
        raised: token('panel2'),
        line: token('line'),
        ink: token('fg'),
        mute: token('muted'),
        accent: token('accent'),
        'accent-ink': token('accent-fg'),
        up: token('up'),
        down: token('down'),
        warn: token('warn'),
      },
      boxShadow: {
        // Hard offset, no blur. Used on things that press and on featured blocks only.
        hard: '3px 3px 0 0 rgb(var(--fg))',
        'hard-sm': '2px 2px 0 0 rgb(var(--fg))',
        'hard-lg': '6px 6px 0 0 rgb(var(--fg))',
      },
      fontFamily: {
        display: ['"Archivo Black"', 'Archivo', 'sans-serif'],
        sans: ['Archivo', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
}
