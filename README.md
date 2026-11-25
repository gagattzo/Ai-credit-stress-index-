# AI Credit Stress Index (ACSI)

This repo holds the static site for the AI Credit Stress Index, a weekly reading of where the stress in AI infrastructure sits: in the debt that financed the build-out, or in what the GPUs earn.

- `index.html` is the page. It does all the scoring in the browser using method v0.1.
- `data.js` holds this edition's inputs, series, loan prints, events, sensitivity table and edition metadata.
- `og.png` is the 1200×630 image used for link previews.

There's no build step: deploy this folder as a static site. On Vercel, set the framework preset to "Other".

To publish a new weekly edition, replace `data.js` (and `og.png` if the reading changes) and push.

Levels come from press reports and public index pages, and each one links to its source. This is not investment advice.
