# Lumarc design direction

Owner direction (requested by the project owner): retro / neo-brutalist. Read this before touching UI, together with the antislop rules.

Design read: non-custodial trading terminal and its landing page, for traders on Arc, in a neo-brutalist retro style. Dial: ENERGY 3 / RHYTHM 3 / MOTION 2.

## Identity

| Part | Decision | Reason |
| --- | --- | --- |
| Surface | Soft mist-blue paper (`#e7edf6`) in light, blue-black (`#13151d`) in dark | A flat printed-page feel is the retro half of the brief. Both themes ship and are tested (R-34) |
| Ink | Near-black 1px borders on every panel, input and button | Hard edges are the neo-brutalist half. Borders carry structure, so no shadows are needed for hierarchy |
| Accent | One flat fill, soft lavender by default (peach, rose, sky, butter in Settings). Soft pastels, always with ink text; the boundary comes from the 1px ink border, never from the fill | One accent used for the primary action and the active state only. Always a fill with ink text, never accent-coloured text, so contrast holds on both themes |
| Semantic | Green and red for buy/sell, gain/loss only | A trading UI needs them. They do not decorate |
| Type | Archivo Black for headings, Archivo for text, IBM Plex Mono for numbers | Archivo is a blunt grotesque with real weight for the poster voice. Plex Mono gives numbers a typewriter feel and tabular alignment. None are the usual AI defaults |
| Radius | 0 everywhere | Square corners are the identity. Round shapes appear only on token images and the status dot |
| Shadow | A hard offset (no blur) on buttons and on featured blocks only | Marks what can be pressed or what is featured. Everything else sits flat |
| Motion | Page fade, press-down on buttons, scroll reveal on the landing page, one looping demo | Fade orients navigation. The press effect confirms a click. The demo is the product shown working. Nothing else loops |

## Rules held on top of the direction

- No gradients, blur, glow, grid or orb backgrounds, emoji, em dashes, or decorative badges.
- Icons are used only where they name a destination, with text labels beside them. Stroke style is set once in `index.css`.
- Every number on the landing page is live or labelled as an example. No invented users, volumes or testimonials.
- Mobile is an app shell: a bottom tab bar, 44px targets, safe-area padding, and 16px inputs so iOS does not zoom.
- Focus is a 3px ink outline everywhere. Nothing removes it without a replacement.
