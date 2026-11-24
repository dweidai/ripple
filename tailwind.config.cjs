/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./public/index.html', './public/app.js'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#fff7ed',
          100: '#ffedd5',
          400: '#fb923c',
          500: '#f97316',
          coral: '#ff6239',
          coralHover: '#ea552e',
          peachBg: '#fff6f1',
          borderSubtle: '#f3eae5'
        },
        surface: {
          canvas: '#f4f3f0',
          card: '#ffffff',
          muted: '#71717a'
        }
      },
      borderRadius: {
        '2.5xl': '1.25rem',
        '3xl': '1.5rem',
        '4xl': '2rem'
      },
      boxShadow: {
        soft: '0 8px 30px rgba(0, 0, 0, 0.04)',
        bubble: '0 2px 10px rgba(0, 0, 0, 0.02)',
        btn: '0 4px 14px rgba(255, 98, 57, 0.28)'
      }
    }
  },
  plugins: [require('@tailwindcss/forms')]
};
