# IPL Auction PPT (Auto-generated)

This folder contains a PowerPoint deck generator that creates a polished, consistent PPT for the IPL Auction website.

## What you get
- A ready-to-edit PowerPoint deck (`ppt/output/IPL_Auction_Website_Overview.pptx`)
- Screenshot placeholders (auto-filled if you add images)
- Speaker notes on each slide with suggested animations (PowerPoint-friendly)

## How to generate
From the repo root:

```powershell
c:/Users/Tilak/Desktop/ipl_auction/.venv/Scripts/python.exe ppt/generate_ppt.py
```

The output deck is written to:
- `ppt/output/IPL_Auction_Website_Overview.pptx`

## Add ultra-high screenshots (recommended)
1. Run the website locally (`npm start`) and open it in Chrome.
2. Set window size to 1920×1080 (or higher like 2560×1440).
3. Take screenshots and save them as PNG files inside:
   - `ppt/assets/screenshots/`
4. Use the exact filenames from:
   - `ppt/assets/manifest.json`
5. Re-run the generator command.

If a screenshot file is present, it will be inserted automatically on its corresponding slide.

### Using the 5 screenshots you already sent in chat
Save each chat image as a `.png` file into `ppt/assets/screenshots/` with these exact names:

- Home (Create tab screen) → `01_home.png`
- Lobby screen (room code + teams grid) → `06_lobby.png`
- Auction screen (player card + bid panel) → `09_auction_overview.png`
- Results “Auction Complete” top section → `14_results.png`
- Results “Re-Auction for Unsold Players” section → `15_reauction.png`

Then re-run the generator.

## How to “download” the PPT
The PPT is generated as a normal file on your PC:
- Output file: `ppt/output/IPL_Auction_Website_Overview.pptx`

To share it, just open that folder in File Explorer and copy/send the `.pptx`.

## Notes about animations
PowerPoint animations/transitions aren’t reliably set by `python-pptx`, so the generator writes animation suggestions to speaker notes. Apply them in PowerPoint using:
- **Fade** (0.2–0.4s) for bullet reveals
- **Morph** (optional) between “flow” slides

## Customizing
- Edit text/structure in `ppt/generate_ppt.py`
- Update screenshot mapping in `ppt/assets/manifest.json`
