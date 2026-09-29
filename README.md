# Build Steps

A phone-first web app for making ThinkPro **build instruction decks** (PowerPoint).

1. **New build**: enter the build name, grade and session.
2. **📷 Add step**: take the photo of the step (or use **🖼 Add steps from gallery** to pick one or more saved photos; each becomes a step, in the order selected), choose the part(s) it uses from the parts list, and type the instruction exactly as it should read on the slide. Steps that only **flip over** or **turn around** the assembly need no part; the slide shows an arrow instead.
3. **Materials required** (the BOM) fills itself in from the parts chosen in the steps, with quantities added up. **Review & edit BOM** lets you change a quantity, hide a part or add an extra part that is not in any step. Edits sit on top of the automatic list, so it keeps updating as steps change, and ↺ returns a part to its automatic count.
4. **Generate deck** makes `<Build>_G<grade>_S<session>_v<n>.pptx`:
   - slide 1: cover with the build name, grade and session
   - slide 2: **Materials Required**, a 3 × 3 grid of part pictures, names and quantities (a 10th part continues on another Materials slide)
   - from slide 3: one slide per step, with "Step N" on the red bar, the instruction highlighted in yellow, the part(s) on the left and the step photo on the right
   - last slide: Thank You

Builds are saved in the browser on the device they were made on. To edit a build later on another phone or laptop, or to keep a backup, use **⋯ → Save build file** and **Open build file**. On iPhone, add the app to the Home Screen (Share → Add to Home Screen) so Safari keeps its saved builds.

Everything runs in the browser, and nothing is uploaded.

## Parts libraries

`public/library/kits.json` lists the kits; each kit has a folder of pictures and a `parts.json` (`id`, `name`, `file`, `w`, `h`).
The Xplorer (Mech) pictures and names are a snapshot of the BOM maker library on glbadmin.thinkpro.academy (`/content/bom/Parts_Library/Xplorer_Mech`, taken 2026-09-29), resized to 600 px.
To add Innovator, Computational or Tronix, add a folder the same way and list it in `kits.json`.

## Slide layout

All positions, sizes and colours are in `LAYOUT` at the top of `src/deck.js`. They use the same 1280 × 720 design-pixel system, backgrounds and fonts as Lesson Foundry. The phone preview uses the same numbers.

## Develop

```
npm install
npm run dev
```

Pushing to `main` builds the app and publishes it to GitHub Pages (`.github/workflows/deploy.yml`).
