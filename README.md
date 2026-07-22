# Schrune VS Code Extension

This extension adds:

- Syntax highlighting for `.schrune` files
- Autocomplete for Schrune keywords, imported parts/modules, and nets
- A left-side Schrune panel for project-oriented CLI commands
- Discovery of every workspace folder containing a `schrune.json`

## CLI setup

The panel runs each command in the directory of the selected `schrune.json`. It
uses the globally installed Schrune npm command (`schrune.cmd` on Windows and
`schrune` on other platforms).

Install the CLI globally before using the panel:

```sh
npm install --global schrune
```

## Commands

- `Schrune: Build Selected Project`
- `Schrune: Add LCSC Part...`
- `Schrune: Install Project Parts`
- `Schrune: Open Project in KiCad`
- `Schrune: Create Project...`

## Notes

- `#include` files are suggested from the workspace.
- Build runs `schrune build`, parts use `schrune parts ...`, and KiCad open runs
  `schrune open-kicad` in the selected project directory.
- Create Project asks for a project name and parent folder, creates a filesystem-safe
  project directory with a starter `main.schrune`, then runs `schrune create`.
- The extension is intentionally lightweight. It does not replace the Schrune compiler.
