# Layout elements: a LumaBooth-style layout editor

Date: 2026-09-24
Status: approved; PR 1 (agent) implemented on feat/layout-elements

## Goal

The operator should be able to design a print layout entirely from the kiosk's
Settings screen: place photos, images, text and shapes, set a background colour,
type exact positions, rotate, align and reorder layers. Today the editor can only
drag photo slots and upload a single full-sheet overlay PNG, so anything else
(event name, date, logo) has to be prepared in an image editor first.

Some content must differ on every print (date, time, a per-guest code, and later a
QR code), so the final composite is rendered by booth-agent at composite time,
not baked in the browser.

## Delivery

Four PRs, each shippable on its own:

1. **Agent: element model and renderer.** New template format, renderer, migration
   of old templates, text variables, asset and font endpoints. The current kiosk
   keeps working unchanged.
2. **Kiosk: editor rewrite.** Selection, drag, numeric inputs, rotation, alignment,
   layers panel, add image/text/shape/background.
3. **Preview, test print, import/export, save as new.**
4. **QR element.** Depends on the Phase 2 download URL (`VITE_DOWNLOAD_URL`).

This spec covers 1-3 in detail. Step 4 is only reserved here (`type: "qr"`).

Deploy order stays as before: the agent ships first, the kiosk is never built ahead
of an agent it depends on.

## 1. Data model

A template replaces `photoSlots` + `overlayFile` with a background colour and an
ordered list of elements. Array order is layer order: the first element is the
bottom layer.

```ts
interface Template {
  id: string;
  name?: string;
  printSize: "4x6" | "2x6-strip";
  cellWidthPx: number;          // unchanged rules: must match printSize
  cellHeightPx: number;
  background: string;           // "#rrggbb", default "#ffffff"
  elements: Element[];
}

interface ElementBase {
  id: string;                   // stable within the template, used by the editor
  x: number; y: number;         // top-left of the unrotated box, cell pixels
  width: number; height: number;
  rotation: number;             // degrees, -180..180, about the box centre
  hidden: boolean;
}

type Element = ElementBase & (
  | { type: "photo"; shot: number }          // 0-based index of the shot to place
  | { type: "image"; file: string }          // an asset of this template
  | { type: "text"; text: string; font: string; size: number; color: string;
      align: "left" | "center" | "right"; bold: boolean }
  | { type: "rect"; fill: string; radius: number; opacity: number }
);
```

Rules:

- **Shot count** = highest `shot` + 1. Every index from 0 to n-1 must appear at
  least once; the same shot may appear more than once. 1 to 12 shots.
- At most 40 elements. Colours are `#rrggbb`. `font` must be one of the bundled
  fonts. Text is at most 500 characters. `size` is in cell pixels.
- Elements may extend past the cell edge; the renderer crops them. Width and
  height must be positive.
- `image.file` must be an asset belonging to this template (see Assets). A save
  can never point an element at an arbitrary path on disk.

### Text variables

Replaced at composite time:

| Variable  | Value                                                        |
|-----------|--------------------------------------------------------------|
| `{event}` | `event.name` from the agent config, falling back to `event.id` |
| `{date}`  | local date, e.g. `24 Sep 2026`                               |
| `{time}`  | local time, e.g. `14:05`                                     |
| `{code}`  | first 8 characters of the first shot's captureId             |

`event.name` is a new optional field in the agent config. Unknown `{...}` text is
printed as typed.

### Fonts

The agent ships a small set of OFL fonts as TTF under `assets/fonts/`: Manrope,
Bricolage Grotesque, Playfair Display (serif) and Great Vibes (script), regular
and bold where the family has both. The editor loads the same files from the agent via
`@font-face`, so the preview and the print use identical font files.

### Migration

Old-format templates (with `photoSlots`) are converted when read and when saved:
each slot becomes a `photo` element with `shot` = slot index, and an overlay
becomes a full-cell `image` element on top. The file is rewritten in the new
format on its next save.

Until PR 2 ships, API responses also include a derived, read-only `photoSlots`
(the boxes of the photo elements, one per shot) and `overlayFile`, so the current
kiosk keeps working. PR 2 removes these fields.

## 2. Agent

### Renderer

`renderCell` is rewritten. It creates the cell filled with `background`, then
composites each visible element in array order:

- `photo`: the shot resized with `fit: "cover"` to width x height (as today).
- `image`: the asset resized with `fit: "fill"` to width x height. Keeping the
  aspect ratio is the editor's job.
- `text`: rendered with sharp's Pango text input, using the bundled `fontfile`,
  wrapped to the box width, aligned per `align`, vertically centred in the box.
  Text taller than the box is cropped.
- `rect`: a small SVG rect with fill, corner radius and opacity.

A non-zero `rotation` rotates the element buffer about its centre on a
transparent background, and the composite position is shifted so the centre stays
put. Any part outside the cell is cropped before compositing, since sharp rejects
overlays that do not fit.

The landscape-to-portrait turn for 4x6 and the two-up mirroring for strips are
unchanged.

### API

| Endpoint                           | Purpose                                                  |
|------------------------------------|----------------------------------------------------------|
| `POST /templates/:id`              | Save. Accepts the old or new format.                     |
| `POST /templates/:id/assets`       | Upload a PNG or JPEG (max 10 MB). Returns `{ file }`.    |
| `GET /templates/:id/assets/:file`  | Serve an asset to the editor.                            |
| `GET /fonts`                       | List bundled fonts: family, weights, file names.         |
| `GET /fonts/:file`                 | Serve a font file.                                       |
| `POST /templates/:id/overlay`      | Kept until PR 2: stores an asset and adds a full-cell top `image` element. |

Asset files are named by the agent as `<templateId>-<random>.<ext>` in the
template directory; the client never chooses the name. Serving an asset checks the
name belongs to that template and contains no path separators.

Cleanup: saving a template deletes that template's assets it no longer
references. Deleting a template deletes all of its assets.

### Validation

Checked on save and on load, and reported back to the editor as an error
message, so a bad layout is caught in Settings rather than on a printed sheet.
A broken file on disk is still skipped by `listTemplates`, as today.

### Tests (vitest)

- Migration of each old-format template in `assets/templates/`.
- Pixel checks: background colour; a photo lands in its box; a rect's colour and
  opacity; a 90-degree rotated element's bounding box; text renders (non-background
  pixels inside its box); an element past the edge is cropped without an error.
- Validation rejects: gaps in shots, too many elements, bad colours, unknown fonts,
  foreign asset names.
- Existing compositor and template tests updated to the new format.

## 3. Kiosk editor

### Layout

Three columns, as in LumaBooth:

- **Left, "Add":** Photo (defaults to the next unused shot, can pick which shot),
  Image (file picker, uploads an asset), Text (defaults to `{event}`), Shape
  (rectangle / rounded rectangle), Background colour, Paper (the existing three
  choices; switching scales all elements).
- **Centre, canvas:** tap to select, drag to move, corner handle to resize,
  10 px snap. The selected element is outlined; hidden elements show
  semi-transparent.
- **Right, "Selected":** X / Y / W / H number fields with +/- buttons (the kiosk is
  a touchscreen and may have no keyboard), rotation with +/-15 degree buttons,
  keep-aspect-ratio toggle, six align-to-canvas buttons (left, centre, right,
  top, middle, bottom). For text: content, variable chips that insert
  `{date}` etc., font, size, colour, bold, alignment. Colours use the native
  colour picker plus a row of preset swatches.
- **Right, "Layers":** top layer first. Each row shows the type and a label
  ("Photo 2", "Text: Gigsmore..."), with show/hide, move up, move down and delete.
  Tapping a row selects the element.
- **Top bar:** undo / redo (last 50 snapshots), Save, Cancel, Delete layout.

Code: `LayoutEditor.tsx` holds the canvas and state; `EditorPanels.tsx` holds the
side panels.

### PR 3 additions

- **Preview:** sends the current draft (saved or not) to a new
  `POST /layout-preview` endpoint (outside `/templates/:id`, so it can't collide
  with a save), which renders it with numbered sample photos, one per shot,
  generated on the agent, and returns the image. Shown in a dialog; this is
  exactly what prints.
- **Test print:** after a confirm ("uses 1 sheet of paper"), prints the
  sample-photo render straight to the hot folder, with no capture or print-job
  record, so nothing is uploaded.
- **Export:** downloads one `.json` file with the template and its assets embedded
  as base64.
- **Import:** picks such a file; the agent validates it, saves it under a new id
  and writes the assets.
- **Save as new:** the agent copies the template and its assets under a new id.

### Testing

The kiosk has no test framework. Each kiosk PR is verified end to end in the
browser against the live agent, as for the overlay editor. Render correctness is
covered by the agent tests.

## Out of scope

Gradients, strokes, shadows, curved text, multi-select, grouping, copy/paste,
smart alignment guides, element locking, a template shop. Add when needed.
