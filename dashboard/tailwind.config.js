/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      animation: {
        'pulse-fast': 'pulse 1s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'flash-green': 'flashGreen 1.5s ease-out forwards',
        'glow': 'glow 2s ease-in-out infinite alternate',
      },
      keyframes: {
        flashGreen: {
          '0%': { transform: 'scale(0.95)', boxShadow: '0 0 0 0 rgba(34, 197, 94, 0.8)' },
          '70%': { transform: 'scale(1.05)', boxShadow: '0 0 0 20px rgba(34, 197, 94, 0)' },
          '100%': { transform: 'scale(1)', boxShadow: '0 0 0 0 rgba(34, 197, 94, 0)' },
        },
        glow: {
          '0%': { filter: 'drop-shadow(0 0 8px rgba(239, 68, 68, 0.5))' },
          '100%': { filter: 'drop-shadow(0 0 20px rgba(239, 68, 68, 0.9))' },
        }
      }
    },
  },
  plugins: [],
}

