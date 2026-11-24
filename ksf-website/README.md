# KSF Food Industries website

A fast, static marketing site for KSF Food Industries (potato chips and corn pops, Lahore, Pakistan). No build step and no server: plain HTML, CSS and a little JavaScript.

| Page | File |
|---|---|
| Home | `index.html` |
| Flavours (with Chips / Pops filter) | `products.html` |
| Our Story | `about.html` |
| Contact Us (sales@ and marketing@ emails, enquiry form, social "coming soon") | `contact.html` |

## Preview locally
Open `index.html` in a browser, or run `python3 -m http.server` inside this folder and visit http://localhost:8000.

## Going live
- **GitHub Pages:** in the repo go to Settings → Pages → Source: *GitHub Actions*. The workflow `.github/workflows/ksf-website-pages.yml` publishes this folder whenever it changes on `main`.
- **Custom domain (ksffood.com):** add the domain in Settings → Pages and point the DNS at GitHub Pages, or upload this folder to any web host (cPanel, Netlify, Vercel, Cloudflare Pages).

## What to send us to finish it
1. ~~Logo~~ added (`assets/ksf-logo.webp`). A high-res or vector version would look sharper.
2. ~~Collection photo~~ added (`assets/ksf-collection.jpg`). Separate photos of each pack would replace the drawn packs on the flavour cards.
3. **Pack sizes and prices** (flavours are now the real six, in `assets/main.js` `FLAVOURS`).
4. **Factory address, phone and WhatsApp** for the Contact page.
5. **Social media links** once the pages are live (Facebook, Instagram, TikTok, YouTube, LinkedIn, X).
6. Claims used come from the pack artwork: 100% vegetarian, real potatoes, quality corn, no artificial colours, no preservatives, Pops baked not fried.

## Editing tips
- Flavours, colours and descriptions: `assets/main.js`, `FLAVOURS` list at the top.
- Colours and fonts: CSS variables at the top of `assets/style.css`.
- The contact form opens the visitor's email app addressed to sales@ or marketing@ (no server needed). Swap in a form service such as Formspree later if you want submissions to arrive directly.
