# REV website v2 (experimental)

An alternative REV site built around the 3D model of Carrera: a dark photo studio with schematic touches. Display type is Martian Mono; lists are set as vinyl decals on carbon fibre or as timing-tower rows with team shortcodes (SUS, CHS, SIM, BAT, PWR, SWS, OPS, MKT) instead of cards. It is for the team to review next to the approved site. It is **not** the published site and doesn't change it: `rev-site/`, `dist/`, `npm start` and `npm test` behave exactly as before. Every v2 page carries `noindex`.

## Run it

```sh
npm ci
npm run start:v2
```

Open http://localhost:3002. To compare, run `npm start` in another terminal for the approved site at http://localhost:3000.

`npm run build:v2` writes `dist-v2/`. It copies the approved photos, fonts, logos and sponsorship packet from `rev-site/assets/` and layers `rev-site-v2/` on top, so the shared media isn't duplicated in git.

## Pages

| Page | What's there |
| --- | --- |
| `index.html` | Studio reveal (a light sweeps the car), then a scroll-driven camera: the array, an x-ray "inside" view with the energy path, a spec profile, and FSGP 2027. Then a "Paddock notes" updates feed, Who we are, The road ahead, partners, FAQ. |
| `car.html` | An orbit viewer with hotspots (monocoque, array, dashboard, suspension, hub motor, battery, power distribution). Each opens the matching system write-up. There is a Studio/Schematic toggle, then the full Carrera content. |
| `garage.html` | Livery Lab: try colours, stripes, a race number and the REV mark on the car, then save an image or share a link. |
| `about.html` | Team: the eight teams as a decal sheet, then leadership and sub-team leads as timing-tower rows with placeholder avatars (headshots deferred, lead names to come). |
| `join.html` | Applications with a team banner photo. The banner is a stand-in until the media team supplies a full-team photo. |
| `sponsorship.html`, `contact.html`, `404.html` | The approved content in the v2 design. |

All copy comes from the approved pages, plus the items from the president's Oct 17 media meeting: the tagline, the ~1,200 ft elevation change of the 2027 circuit, and the planned November livery competition.

## Updating content

- **Updates feed**: in `index.html`, copy an `<li class="post">` inside `.feed`, newest first. Use real dates in `<time datetime>`.
- **Header and footer**: edit them in `contact.html`, then run `python3 lab/v2-partials.py` on a page that still has the `<!--HEADER-->` placeholders. Existing pages hold their own copy, so change those too.
- **Lead names and headshots**: in `about.html`, replace "Lead: name coming soon" in each `.tower-row` and swap the `.tower-avatar` placeholder for a photo.

## How the 3D works

- `assets/js/studio.js` is the shared engine. It handles the studio lighting and floor, materials, quality tiers, the x-ray/schematic layer and an on-demand render loop. Pages own their camera and story (`home.js`, `car.js`, `garage.js`).
- **Model**: `assets/models/carrera-v2.glb` (687 KB, meshopt-compressed) and `carrera-v2-hotspots.json` (hotspot anchors, wheel axles, body UV atlas). It is rebuilt from the scan by `lab/carrera/scripts/build_v2.sh`; see `lab/carrera/README.md`. When the mech team's hand-made model arrives, point that script at it, or export it with the same node and material names.
- **Axes**: metres, +Y up, nose toward +Z, car-left (canopy side) +X, origin on the ground.
- **Load order**: text, fonts and images first. three.js and the model start only after the page's `load` event, while the poster image (`assets/img/v2/`) fills the stage.
- **Fallbacks**: reduced-motion visitors keep the still poster on Home; on Carrera, they get a button to open the viewer. No-WebGL browsers keep the poster.
- **Quality tiers**: `?quality=low` or `?quality=high` forces a tier for testing.

## Known limits

- Battery, power-electronics and hub-motor positions in the schematic are illustrative, not from CAD. The page says so where they appear.
- The light strip on the trailing edge is shown as a red tail light.
- Wheels are reconstructed. The body fairings hide most of them except in the schematic view.
- See `PERFORMANCE.md` for load and frame-rate measurements.
