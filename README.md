# Sea of Grass

Source for [seaofgrass.studio](https://seaofgrass.studio).

Hand-coded static site — no build step, no dependencies. Open a file in a browser and
you are looking at the real thing.

## Structure

```
index.html                    landing page: the mark, and the index of studies
studies/
  scrollwork/index.html       Study 01 — self-contained, ~10 KB
assets/
  logo.svg                    the mark, fill="currentColor" (inherits type color)
  favicon.svg                 same mark, explicit fill, a little padding
CNAME                         binds the custom domain — do not delete
.nojekyll                     serve files as-is, no Jekyll processing
```

## Local preview

Absolute paths (`/assets/…`, `/studies/…`) need a server root, so serve the folder
rather than opening `index.html` off the filesystem:

    python3 -m http.server 8000

## Deploying

Push to `main` — GitHub Pages rebuilds automatically. There is nothing else to run.

> The domain is **not** served from Hostinger, even though a copy of an older
> `index.html` still sits in a Hostinger document root for `seaofgrass.studio`. That
> copy serves no traffic. DNS points at GitHub Pages (`185.199.108–111.153`).

## How a study works

Each study is one self-contained HTML file: its own CSS and JS inline, no shared
stylesheet, no framework. That constraint is the point — a study should be readable
top to bottom in one sitting, and should still run in ten years.

Shared conventions across the site, rather than shared code:

| | |
|---|---|
| Paper | `#faf9f6` |
| Ink | `#141311` |
| Hairline | `#d9d6cf` |
| Ink, soft | `rgba(20,19,17,.5)` |
| Type | IBM Plex Mono, 400 / 500 |

Labels are uppercase, `letter-spacing: .14em`, 13px. Numbers use
`font-variant-numeric: tabular-nums`.

Where a study adapts someone else's technique, it credits the source **on the face of
the page**, not in a comment. Scrollwork does this and it should stay the rule.

## Adding a study

1. `studies/<name>/index.html` — self-contained.
2. Link the mark back to `/` in the top-left, so the study is never a dead end.
3. Add a row to the `<ol>` in the root `index.html` and bump the count in
   `.studies-head`.

## Who

Tristan Brewer and Bryce Nielsen. Founded September 2025.
