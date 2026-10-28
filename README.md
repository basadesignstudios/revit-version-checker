# Revit Version Checker

Drop a Revit file (`.rvt`, `.rfa`, `.rte`, `.rft`) on the page and see which Revit version last saved it. It's a static site with no build step and no dependencies, and **the file never leaves your computer**. All reading happens in the browser with `File.slice()`, and the page makes no network requests while it parses.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page markup |
| `style.css` | Styling (blue accent) |
| `fonts/` | Syne and Plus Jakarta Sans web fonts, with their SIL Open Font License files |
| `app.js` | Parser and UI. The parser also runs in Node for tests |
| `tests/parse.test.mjs` | Runs the parser against real files (Node built-ins only) |

## How detection works

Revit files are **OLE Compound File Binary (CFB)** containers, which work like a small FAT file system inside one file. Revit writes its version info as UTF-16LE text into a stream called `BasicFileInfo`. That's why searching for `F o r m a t` in Notepad works.

1. **Read the 512-byte header.** It confirms the CFB signature and gives the sector size, where the directory starts, the mini-stream cutoff, and the first 109 FAT locations (DIFAT).
2. **Walk the directory** sector by sector. Each sector holds 128-byte entries. The walk stops at the entry named `BasicFileInfo`. FAT sectors are loaded only when a chain needs them.
3. **Read only that stream.** Streams at or above the 4096-byte cutoff are read through the FAT. Smaller streams are read through the mini FAT, as 64-byte mini sectors inside the root entry's mini stream. In practice that's about 15 KB of I/O, even for a 500 MB model.
4. **Decode and match** in priority order:
   1. `Format: YYYY` (Revit 2019 and later)
   2. `Autodesk Revit (LT )?YYYY` (older files)
   3. A 4-digit year (2000–2099) at the start of the `Build:` value. This is the build *date*, so the page marks the result as an estimate.

   Because the strings can start at either byte alignment, the parser decodes both. If "Revit LT" appears, the page shows a badge.
5. **Fallback.** If CFB parsing fails because the file is damaged or the structure is unexpected, the parser scans the file in 8 MB slices for the UTF-16LE bytes of `Format: ` and `Autodesk Revit`. Slices overlap so a match can't be split across a boundary. The scan stops at the first confident match and shows a progress bar.

## Testing

```bash
node tests/parse.test.mjs                       # every Revit file in ./samples
node tests/parse.test.mjs "C:\path\to\file.rvt" # or any files/folders
```

The test runs the same `app.js` code in a Node `vm` sandbox. It also runs the fallback scan on its own and reports whether the scan agrees with the CFB result.

## Deploy to GitHub Pages

1. Create a new GitHub repository and push the contents of this folder to the `main` branch. `index.html` must be at the repository root.
2. In the repository, open **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to *Deploy from a branch*, then choose `main` and `/ (root)`. Click **Save**.
4. After a minute the site is live at `https://<user>.github.io/<repo>/`. You can open the same `index.html` directly from disk too.
