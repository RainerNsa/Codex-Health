// Direction A, "Chart Room": serious, dense, instrument-like. Every colour is a semantic token with a dark value, so
// components never name a raw colour. Outcome colours are separate from the brand navy and always travel with a word.
import { createSystem, defaultConfig, defineConfig } from '@chakra-ui/react';

const pair = (base: string, dark: string) => ({ value: { base, _dark: dark } });

export const system = createSystem(defaultConfig, defineConfig({
  globalCss: {
    'html, body': { bg: 'canvas', color: 'ink', fontFamily: 'body' },
    'input[type=checkbox], input[type=radio]': { accentColor: 'var(--chakra-colors-brand-solid)', width: '1rem', height: '1rem' },
    '*:focus-visible': { outline: '2px solid var(--chakra-colors-brand-solid)', outlineOffset: '2px' },
  },
  theme: {
    tokens: {
      fonts: {
        heading: { value: "'Public Sans Variable', 'Public Sans', -apple-system, 'Segoe UI', sans-serif" },
        body: { value: "'Public Sans Variable', 'Public Sans', -apple-system, 'Segoe UI', sans-serif" },
        mono: { value: "'IBM Plex Mono', ui-monospace, Menlo, monospace" },
      },
    },
    semanticTokens: {
      radii: { l1: { value: '2px' }, l2: { value: '3px' }, l3: { value: '4px' } },
      colors: {
        canvas: pair('#f3f5f7', '#10161c'), surface: pair('#ffffff', '#18212a'), ink: pair('#17212b', '#e5ebf1'),
        muted: pair('#566472', '#9aa8b5'), line: pair('#d7dee5', '#2b3743'),
        rail: pair('#14304d', '#0c141c'), railInk: pair('#dbe6f0', '#cbd8e4'), signal: pair('#2f8fc4', '#7cc4e8'),
        admit: pair('#1c6b4a', '#6fcda4'), admitSoft: pair('#e1f0e9', '#17302a'),
        review: pair('#8a5600', '#e4b869'), reviewSoft: pair('#f8eedb', '#302718'),
        stop: pair('#a12a2a', '#f09a9a'), stopSoft: pair('#f8e4e4', '#351e1e'),
        info: pair('#1d4e79', '#8db8de'), infoSoft: pair('#e3ecf4', '#1d2c3a'),
        brand: {
          solid: pair('#1d4e79', '#8db8de'), contrast: pair('#ffffff', '#10161c'), fg: pair('#1d4e79', '#8db8de'),
          muted: pair('#cddcea', '#26394b'), subtle: pair('#e3ecf4', '#1d2c3a'), emphasized: pair('#b7cde0', '#2f4659'), focusRing: pair('#1d4e79', '#8db8de'),
        },
      },
    },
  },
}));
