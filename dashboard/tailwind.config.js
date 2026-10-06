/**
 * Colors are driven by CSS variables (space-separated RGB channels) so a single
 * `data-theme` attribute on <html> reskins the whole app — every existing
 * `bg-ink-900`, `text-slate-300/60` etc. becomes theme-aware for free. The
 * channel values live in index.css under :root and :root[data-theme="light"].
 */
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        // The type system: Bebas for the display voice, Plus Jakarta for UI.
        display: ['"Bebas Neue"', 'Impact', 'system-ui', 'sans-serif'],
        sans: ['"Plus Jakarta Sans"', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      colors: {
        // The console's own brand accent — the colour the ISL mark in Logo.jsx is drawn in.
        brand: {
          DEFAULT: v('brand'),
          light: v('brand-light'),
          dark: v('brand-dark'),
          muted: v('brand-muted'),
        },
        cream: v('cream'),
        ink: {
          950: v('ink-950'),
          900: v('ink-900'),
          850: v('ink-850'),
          800: v('ink-800'),
          700: v('ink-700'),
          600: v('ink-600'),
          500: v('ink-500'),
        },
        slate: {
          200: v('slate-200'),
          300: v('slate-300'),
          400: v('slate-400'),
          500: v('slate-500'),
          600: v('slate-600'),
          700: v('slate-700'),
          900: v('ink-900'),
        },
        white: v('content-strong'),
      },
      boxShadow: {
        lift: '0 10px 30px -12px rgb(var(--shadow) / 0.45)',
        glow: '0 0 0 1px rgb(var(--brand) / 0.35), 0 8px 24px -8px rgb(var(--brand) / 0.4)',
      },
      keyframes: {
        pulseRing: {
          '0%': { boxShadow: '0 0 0 0 rgba(52,211,153,0.5)' },
          '100%': { boxShadow: '0 0 0 10px rgba(52,211,153,0)' },
        },
        slideIn: {
          '0%': { transform: 'translateX(110%)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' },
        },
        fadeIn: { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
      },
      animation: {
        pulseRing: 'pulseRing 1.8s ease-out infinite',
        slideIn: 'slideIn 0.22s cubic-bezier(0.16,1,0.3,1)',
        fadeIn: 'fadeIn 0.15s ease-out',
      },
    },
  },
  plugins: [],
};
