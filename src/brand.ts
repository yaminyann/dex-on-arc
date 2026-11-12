/**
 * Platform identity in one place. Change the name, tagline or any link here (or through the VITE_*
 * variables) and the header, footer, page title and agent all follow.
 *
 * Social links are never invented: a link shows only when its variable is set. GitHub defaults to this
 * repository.
 */
const env = import.meta.env

const clean = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  return /^https:\/\//.test(t) ? t : undefined
}

export const BRAND = {
  name: 'Arcora',
  tagline: 'Trade, lend and automate on Arc',
  description: 'A non-custodial trading terminal for Arc: aggregator swaps, escrowed limit, stop and DCA orders, and a command-driven agent.',
  links: {
    x: clean(env.VITE_SOCIAL_X),
    discord: clean(env.VITE_SOCIAL_DISCORD),
    telegram: clean(env.VITE_SOCIAL_TELEGRAM),
    github: clean(env.VITE_SOCIAL_GITHUB) ?? 'https://github.com/yaminyann/dex-on-arc',
    docs: clean(env.VITE_DOCS_URL) ?? 'https://github.com/yaminyann/dex-on-arc/tree/main/docs',
    support: clean(env.VITE_SUPPORT_URL),
    terms: clean(env.VITE_TERMS_URL),
    privacy: clean(env.VITE_PRIVACY_URL),
  },
} as const
