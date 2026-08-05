/** @type {import('tailwindcss').Config} */

const sizes = {
  '2xs': 0.5,
  xs: 0.75,
  sm: 0.875,
  base: 1,
  lg: 1.125,
  xl: 1.25,
};

const iconMultiplier = 1.25;
const chatMaxWidth = '48rem';

function getSize(sizeLabel, multiplier = 1) {
  return sizes[sizeLabel] * multiplier + 'rem';
}

function getMutedColor({ opacityValue, opacityVariable } = {}) {
  const token =
    opacityVariable === '--tw-text-opacity' ? '--fg-muted' : '--muted';

  if (opacityValue !== undefined) {
    return `hsl(var(${token}) / ${opacityValue})`;
  }
  if (opacityVariable !== undefined) {
    return `hsl(var(${token}) / var(${opacityVariable}))`;
  }
  return `hsl(var(${token}))`;
}

module.exports = {
  darkMode: ['class'],
  important: false,
  content: [
    './pages/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './app/**/*.{ts,tsx}',
    './src/**/*.{ts,tsx}',
    '../web-core/src/**/*.{ts,tsx}',
    '../ui/src/**/*.{ts,tsx}',
    'node_modules/@rjsf/shadcn/src/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  safelist: [
    'xl:hidden',
    'xl:relative',
    'xl:inset-auto',
    'xl:z-auto',
    'xl:h-full',
    'xl:w-[800px]',
    'xl:flex',
    'xl:flex-1',
    'xl:min-w-0',
    'xl:overflow-y-auto',
    'xl:opacity-100',
    'xl:pointer-events-auto',
  ],
  prefix: '',
  theme: {
    container: {
      center: true,
      padding: '2rem',
      screens: {
        '2xl': '1400px',
      },
    },
    extend: {
      height: {
        cta: '29px',
      },
      minHeight: {
        cta: '29px',
      },
      width: {
        chat: chatMaxWidth,
      },
      containers: {
        chat: chatMaxWidth,
      },
      size: {
        'icon-2xs': getSize('2xs', iconMultiplier),
        'icon-xs': getSize('xs', iconMultiplier),
        'icon-sm': getSize('sm', iconMultiplier),
        'icon-base': getSize('base', iconMultiplier),
        'icon-lg': getSize('lg', iconMultiplier),
        'icon-xl': getSize('xl', iconMultiplier),
        dot: '0.3rem', // 6px - for animated indicator dots
      },
      backgroundImage: {
        'diagonal-lines': `
          repeating-linear-gradient(-45deg, hsl(var(--text-low) / 0.4) 0 2px, transparent 1px 12px),
          linear-gradient(hsl(var(--bg-primary)), hsl(var(--bg-primary)))
        `,
      },
      ringColor: {
        DEFAULT: 'hsl(var(--brand))',
      },
      fontSize: {
        micro: ['0.5625rem', { lineHeight: '0.75rem' }],
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
        xs: ['0.75rem', { lineHeight: '1.0625rem' }],
        sm: ['0.875rem', { lineHeight: '1.25rem' }],
        base: ['1rem', { lineHeight: '1.5rem' }],
        lg: ['1.125rem', { lineHeight: '1.625rem' }],
        xl: ['1.25rem', { lineHeight: '1.75rem' }],
        '2xl': ['1.5rem', { lineHeight: '2rem' }],
        cta: ['1rem', { lineHeight: '1rem' }],
      },
      spacing: {
        1: '0.25rem',
        2: '0.5rem',
        3: '0.75rem',
        4: '1rem',
        5: '1.25rem',
        6: '1.5rem',
        8: '2rem',
        half: '0.5rem',
        base: '0.75rem',
        plusfifty: '0.75rem',
        double: '1rem',
      },
      colors: {
        // Legacy text colors: text-high, text-normal, text-low
        high: 'hsl(var(--text-high))',
        normal: 'hsl(var(--text-normal))',
        low: 'hsl(var(--text-low))',
        // Legacy background colors: bg-primary, bg-secondary, bg-panel
        primary: 'hsl(var(--bg-primary))',
        secondary: 'hsl(var(--bg-secondary))',
        panel: 'hsl(var(--bg-panel))',
        // Surface and text namespace
        canvas: 'hsl(var(--bg-canvas))',
        surface: 'hsl(var(--bg-surface))',
        sunken: 'hsl(var(--bg-sunken))',
        overlay: 'hsl(var(--bg-overlay))',
        strong: 'hsl(var(--fg-strong))',
        default: 'hsl(var(--fg-default))',
        muted: getMutedColor,
        'fg-muted': 'hsl(var(--fg-muted))',
        subtle: 'hsl(var(--fg-subtle))',
        'border-strong': 'hsl(var(--border-strong))',
        tertiary: 'hsl(var(--tertiary))',
        // Accent colors
        brand: 'hsl(var(--brand))',
        'brand-hover': 'hsl(var(--brand-hover))',
        'brand-active': 'hsl(var(--brand-active))',
        'brand-secondary': 'hsl(var(--brand-secondary))',
        error: 'hsl(var(--error))',
        success: 'hsl(var(--success))',
        warning: 'hsl(var(--warning))',
        merged: 'hsl(var(--merged))',
        // Text on accent
        'on-brand': 'hsl(var(--text-on-brand))',
        // shadcn-style colors
        background: 'hsl(var(--bg-primary))',
        foreground: 'hsl(var(--text-normal))',
        'primary-foreground': 'hsl(var(--primary-foreground))',
        'secondary-foreground': 'hsl(var(--secondary-foreground))',
        'muted-foreground': 'hsl(var(--muted-foreground))',
        accent: 'hsl(var(--accent))',
        'accent-foreground': 'hsl(var(--accent-foreground))',
        popover: 'hsl(var(--popover))',
        'popover-foreground': 'hsl(var(--popover-foreground))',
        card: 'hsl(var(--card))',
        'card-foreground': 'hsl(var(--card-foreground))',
        destructive: 'hsl(var(--destructive))',
        'destructive-foreground': 'hsl(var(--destructive-foreground))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        border: 'hsl(var(--border))',
      },
      borderColor: {
        DEFAULT: 'hsl(var(--border))',
        border: 'hsl(var(--border))',
      },
      borderRadius: {
        none: '0',
        sm: '0.25rem',
        DEFAULT: '0.375rem',
        md: '0.5rem',
        lg: '0.625rem',
        xl: '0.75rem',
        full: '9999px',
      },
      borderWidth: {
        base: getSize('base'),
        half: getSize('base', 0.5),
      },
      fontFamily: {
        'ibm-plex-sans': ['"IBM Plex Sans"', '"Noto Emoji"', 'sans-serif'],
        'ibm-plex-mono': ['"IBM Plex Mono"', 'monospace'],
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
        pill: {
          '0%': { opacity: '0' },
          '10%': { opacity: '1' },
          '80%': { opacity: '1' },
          '100%': { opacity: '0' },
        },
        'running-dot': {
          '0%, 100%': { opacity: '0.3' },
          '50%': { opacity: '1' },
        },
        'border-flash': {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        shake: {
          '0%, 100%': { transform: 'translateX(0)' },
          '10%, 30%, 50%, 70%, 90%': { transform: 'translateX(-2px)' },
          '20%, 40%, 60%, 80%': { transform: 'translateX(2px)' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        pill: 'pill 2s ease-in-out forwards',
        'running-dot-1': 'running-dot 1.4s ease-in-out infinite',
        'running-dot-2': 'running-dot 1.4s ease-in-out 0.2s infinite',
        'running-dot-3': 'running-dot 1.4s ease-in-out 0.4s infinite',
        'border-flash': 'border-flash 2s linear infinite',
        shake: 'shake 0.3s ease-in-out',
      },
    },
  },
  plugins: [
    require('tailwindcss-animate'),
    require('@tailwindcss/container-queries'),
    require('tailwind-scrollbar')({ nocompatible: true }),
  ],
};
