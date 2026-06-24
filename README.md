# Schrune VS Code Extension

This extension adds:

- Syntax highlighting for `.schrune` files
- Autocomplete for Schrune keywords, imported parts/modules, and nets
- A left-side Schrune panel with build, add-part, and KiCad open actions

## CLI setup

The panel and commands try to run Schrune in this order:

1. A sibling checkout at `../Schrune/src/app.js` if it exists
2. A configured executable from `schrune.cli.executable`
3. `schrune` on `PATH`

If you want to use a local Schrune checkout directly, set:

- `schrune.cli.executable` to `node`
- `schrune.cli.scriptPath` to the Schrune `src/app.js` path

To open generated files in KiCad, set `schrune.kicad.executable` if `kicad` is not already on `PATH`.

## Commands

- `Schrune: Build Current File`
- `Schrune: Build File...`
- `Schrune: Add LCSC Part...`
- `Schrune: Open Schematic in KiCad`
- `Schrune: Open Layout in KiCad`

## Notes

- `#include` files are suggested from the workspace.
- The extension is intentionally lightweight. It does not replace the Schrune compiler.
