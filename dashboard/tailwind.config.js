/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Near-black surfaces, darkest first
        ink: {
          950: '#07090d',
          900: '#0c0f15',
          850: '#11151d',
          800: '#171c26',
          700: '#202735',
        },
        // Brand accent
        atom: '#5eead4',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Cascadia Code', 'Menlo', 'Consolas', 'monospace'],
      },
      keyframes: {
        'slide-in': {
          from: { transform: 'translateX(100%)' },
          to: { transform: 'translateX(0)' },
        },
        'rise-in': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
      },
      animation: {
        'slide-in': 'slide-in 180ms ease-out',
        'rise-in': 'rise-in 160ms ease-out',
        'fade-in': 'fade-in 160ms ease-out',
        orbit: 'spin 24s linear infinite',
      },
    },
  },
  plugins: [],
}
