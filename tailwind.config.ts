import type { Config } from 'tailwindcss';

/**
 * Restrained finance palette: neutral ground, one accent (indigo) for
 * interaction, and semantic green/red reserved exclusively for signed figures
 * so colour always means the same thing.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: '#f7f8fa',
        surface: '#ffffff',
        ink: {
          DEFAULT: '#0f172a',
          muted: '#475569',
          faint: '#94a3b8',
        },
        line: '#e2e8f0',
        accent: {
          DEFAULT: '#4338ca',
          soft: '#eef2ff',
          hover: '#3730a3',
        },
        positive: '#047857',
        negative: '#be123c',
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        'kpi': ['2rem', { lineHeight: '1.1', letterSpacing: '-0.02em' }],
      },
      boxShadow: {
        card: '0 1px 2px 0 rgb(15 23 42 / 0.04), 0 1px 3px 0 rgb(15 23 42 / 0.06)',
        pop: '0 4px 6px -1px rgb(15 23 42 / 0.08), 0 10px 24px -4px rgb(15 23 42 / 0.10)',
      },
      gridTemplateColumns: {
        kpi: 'repeat(auto-fit, minmax(220px, 1fr))',
      },
    },
  },
  plugins: [],
};

export default config;
