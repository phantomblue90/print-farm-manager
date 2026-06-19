# Filament Library

Administrator-managed canonical lists of filament types and filament colors. These lists are the single source of truth for what materials and colors exist in the farm — printers and G-codes select from them rather than entering free text.

## Tables

### `filament_types`

| Column | Type    | Notes |
|--------|---------|-------|
| `id`   | INTEGER | PK, autoincrement |
| `name` | TEXT    | Unique, e.g. "PLA", "PETG", "ASA" |

### `filament_colors`

| Column      | Type    | Notes |
|-------------|---------|-------|
| `id`        | INTEGER | PK, autoincrement |
| `name`      | TEXT    | Unique, e.g. "Black", "Galaxy Red", "Hedgehog Make Galaxy Red" |
| `hex_color` | TEXT    | Optional hex code, e.g. "#FF0000". Shown as a color swatch in the Settings table. |

## API Endpoints — `server/routes/filaments.js`

All endpoints are mounted at `/api/filaments`.

### `GET /api/filaments/types`
Returns all filament types ordered by name.
```json
[{ "id": 1, "name": "PLA" }, { "id": 2, "name": "PETG" }]
```

### `POST /api/filaments/types`
Add a new filament type.
- Body: `{ "name": "ASA" }`
- Returns: the created row (201)
- Errors: 400 if name missing, 409 if name already exists

### `DELETE /api/filaments/types/:id`
Remove a filament type by ID.
- No foreign-key block — deleting a type does not clear printers or G-codes that reference it by name. The stored name string remains; the operator resolves via the printer/gcode form on next edit.
- Returns 404 if not found.

### `GET /api/filaments/colors`
Returns all filament colors ordered by name.
```json
[{ "id": 1, "name": "Black", "hex_color": "#000000" }, { "id": 2, "name": "Galaxy Red", "hex_color": null }]
```

### `POST /api/filaments/colors`
Add a new filament color.
- Body: `{ "name": "Galaxy Red", "hex_color": "#C0392B" }` — `hex_color` is optional.
- Returns: the created row (201)
- Errors: 400 if name missing, 409 if name already exists

### `DELETE /api/filaments/colors/:id`
Remove a filament color by ID. Same non-blocking behavior as type deletion.

## Where filament data is used

| Location | Field | Meaning |
|----------|-------|---------|
| `printers.loaded_material` | type name | What material is currently loaded on the printer |
| `printers.loaded_color` | color name | What color is currently loaded on the printer |
| `gcodes.required_material` | type name | Material required to print this G-code |
| `gcodes.required_color` | color name | Color required to print this G-code |

The scheduler uses `required_material` and `required_color` to match G-codes to printers with matching `loaded_material` / `loaded_color`.

## Settings UI

The **Filament Library** section in Settings has two sub-sections:

**Filament Types** — table of all types with delete buttons; add form with a required name field.

**Filament Colors** — table of all colors (with hex swatch if provided) and delete buttons; add form with a required name field and optional hex color picker.

## Client usage

All client pages that show material/color pickers (Settings add-printer form, Printers bulk edit, PrinterDetail edit form, Projects G-code upload and edit) fetch from `/api/filaments/types` and `/api/filaments/colors` and render `<select>` dropdowns rather than free-text `<input>` elements.
