import tailwindcssAnimate from 'tailwindcss-animate';

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'], // If using shadcn/ui dark mode
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}', // Include if using Pages Router alongside App Router
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
    './src/**/*.{js,ts,jsx,tsx}', // Broader catch-all for src directory if needed
    './node_modules/@solana/wallet-adapter-react-ui/styles.css', // Add this to include wallet adapter styles
  ],
  prefix: '', // If using shadcn/ui
  theme: {
  	container: {
  		center: true,
  		padding: '2rem',
  		screens: {
  			'2xl': '1400px'
  		}
  	},
  	extend: {
  		fontFamily: {
  			'herborn': ['"HERBORN"', '"Helvetica Neue"', 'Helvetica', 'Arial', 'sans-serif'],
  			'helvetica': ['"Helvetica Neue"', 'Helvetica', 'Arial', 'sans-serif'],
  			sans: ['"Helvetica Neue"', 'Helvetica', 'Arial', 'sans-serif'],
  		},
  		keyframes: {
  			'accordion-down': {
  				from: {
  					height: '0'
  				},
  				to: {
  					height: 'var(--radix-accordion-content-height)'
  				}
  			},
  			'accordion-up': {
  				from: {
  					height: 'var(--radix-accordion-content-height)'
  				},
  				to: {
  					height: '0'
  				}
  			},
  			jumpIn: {
  				'0%': {
  					opacity: '0',
  					transform: 'translateY(120px) scale(0.6)'
  				},
  				'8%': {
  					opacity: '1',
  					transform: 'translateY(-30px) scale(1.1)'
  				},
  				'16%': {
  					transform: 'translateY(10px) scale(0.95)'
  				},
  				'24%': {
  					transform: 'translateY(-25px) scale(1.05)'
  				},
  				'32%': {
  					transform: 'translateY(8px) scale(0.98)'
  				},
  				'40%': {
  					transform: 'translateY(-20px) scale(1.02)'
  				},
  				'48%': {
  					transform: 'translateY(5px) scale(0.99)'
  				},
  				'56%': {
  					transform: 'translateY(-15px) scale(1.01)'
  				},
  				'64%': {
  					transform: 'translateY(3px) scale(1)'
  				},
  				'72%': {
  					transform: 'translateY(-10px) scale(1.005)'
  				},
  				'80%': {
  					transform: 'translateY(2px) scale(1)'
  				},
  				'88%': {
  					transform: 'translateY(-5px) scale(1)'
  				},
  				'96%': {
  					transform: 'translateY(1px) scale(1)'
  				},
  				'100%': {
  					opacity: '1',
  					transform: 'translateY(0px) scale(1)'
  				},
  			},
  		},
  		animation: {
  			'accordion-down': 'accordion-down 0.2s ease-out',
  			'accordion-up': 'accordion-up 0.2s ease-out',
  			'spin-slow': 'spin 8s linear infinite',
  			'jump-in': 'jumpIn 3s cubic-bezier(0.175, 0.885, 0.32, 1.275) 0.3s both',
  		},
  		borderRadius: {
  			lg: 'var(--radius)',
  			md: 'calc(var(--radius) - 2px)',
  			sm: 'calc(var(--radius) - 4px)'
  		},
  				colors: {
			background: 'hsl(var(--background))',
			foreground: 'hsl(var(--foreground))',
  			card: {
  				DEFAULT: 'hsl(var(--card))',
  				foreground: 'hsl(var(--card-foreground))'
  			},
  			popover: {
  				DEFAULT: 'hsl(var(--popover))',
  				foreground: 'hsl(var(--popover-foreground))'
  			},
  			primary: {
  				DEFAULT: 'hsl(var(--primary))',
  				foreground: 'hsl(var(--primary-foreground))'
  			},
  			secondary: {
  				DEFAULT: 'hsl(var(--secondary))',
  				foreground: 'hsl(var(--secondary-foreground))'
  			},
  			muted: {
  				DEFAULT: 'hsl(var(--muted))',
  				foreground: 'hsl(var(--muted-foreground))'
  			},
  			accent: {
  				DEFAULT: 'hsl(var(--accent))',
  				foreground: 'hsl(var(--accent-foreground))'
  			},
  			destructive: {
  				DEFAULT: 'hsl(var(--destructive))',
  				foreground: 'hsl(var(--destructive-foreground))'
  			},
  			border: 'hsl(var(--border))',
  			input: 'hsl(var(--input))',
  			ring: 'hsl(var(--ring))',
  			chart: {
  				1: 'hsl(var(--chart-1))',
  				2: 'hsl(var(--chart-2))',
  				3: 'hsl(var(--chart-3))',
  				4: 'hsl(var(--chart-4))',
  				5: 'hsl(var(--chart-5))'
  			}
  		},
		backgroundImage: {
			'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
			'gradient-conic': 'conic-gradient(from 180deg at 50% 50%, var(--tw-gradient-stops))',
		},

		// Enhanced spacing for modern design
		spacing: {
			'18': '4.5rem',
			'88': '22rem',
			'128': '32rem',
		},

		// Modern typography scale
		fontSize: {
			'2xs': ['0.625rem', { lineHeight: '0.75rem' }],
			'5xl': ['3rem', { lineHeight: '1.1' }],
			'6xl': ['3.75rem', { lineHeight: '1' }],
			'7xl': ['4.5rem', { lineHeight: '1' }],
			'8xl': ['6rem', { lineHeight: '1' }],
			'9xl': ['8rem', { lineHeight: '1' }],
		},

  	}
  },
  plugins: [tailwindcssAnimate], // If using shadcn/ui animations
}; 