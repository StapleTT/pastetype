# PasteType

A Firefox extension that types a pasted chunk of text into a focused field as if a
human were entering it. It offers an adjustable typing speed, speed variation,
random human-like pauses, and a sound when it finishes.

## Features

- **Speed slider (WPM):** 10 to 200 words per minute (5 chars/word).
- **Speed variation:** a per-keystroke deviation (0 to 80%) using a gaussian
  spread, so the rhythm isn't robotic.
- **Humanize pauses:** choose Off, Light, Medium, or Heavy. This adds multi-second
  pauses after finishing a sentence, shorter pauses after commas, and the
  occasional random hesitation, and the slider scales all of these.
- **Simulate typos:** an optional setting. Every so often a neighbouring
  (QWERTY-adjacent) key is typed by mistake, left briefly, then backspaced and
  corrected before typing continues.
- **Click to pick a field:** after pressing Start, hovering shows a highlight and
  a click chooses the target field, so you don't need to keep it focused while you
  open the popup.
- **Progress bar:** a bar showing percent complete and an estimated time remaining
  floats just above the chosen field while it types.
- **Completion sound:** a short two-note chime plays when typing finishes, and you
  can toggle it off.
- Works in `<input>`, `<textarea>`, and `contenteditable` (rich text) fields.
- Press **Esc** on the page (or **Cancel** in the banner) to stop early.

## Install (temporary, for development)
1. Open Firefox and go to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**
3. Select the `manifest.json` file in this folder.

The PasteType icon appears in the toolbar. Temporary add-ons are removed when
Firefox restarts. To package permanently, zip the folder's contents and submit to
addons.mozilla.org, or use `web-ext`.

## Usage
1. Click the PasteType toolbar icon.
2. Paste your text and set the WPM, variation, and pauses.
3. Press **Start typing**. A banner appears on the page.
4. Click the text field you want typed into (hovering shows a highlight). A
   progress bar appears above it and typing begins.
5. Hear the chime when it's done. Press **Esc** or **Cancel** to stop mid-way.

## Notes
- It can't run on browser-internal pages such as `about:`, `addons.mozilla.org`,
  and the Add-ons Manager, because Firefox blocks extensions there.
- The completion sound uses the Web Audio API, so some pages with strict autoplay
  settings may suppress it until the page has received a click.

## Files
| File | Purpose |
|------|---------|
| `manifest.json` | Extension manifest (MV3). |
| `popup.html` / `popup.css` / `popup.js` | The toolbar popup UI and controls. |
| `content.js` | Runs in the page, performs the human-like typing, and plays the sound. |
| `icons/icon.svg` | Toolbar icon. |
