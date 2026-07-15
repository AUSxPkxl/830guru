# Komatsu 830E Guru

A local-first assistant prototype for Komatsu 830E-1AC truck manuals, specs, procedures, fault codes, pressures, parts references, and source-page previews.

## What is built now

- Fast desktop web app with chat, previous questions, quick categories, notes, document library, and source preview panel.
- Local Node server with no npm dependencies.
- OpenAI Responses API adapter when `OPENAI_API_KEY` is configured later.
- Source-only demo mode when no API key is configured, so the UI can be tested immediately without pretending to know specs.
- Manual upload storage in `data/manuals`.
- Source metadata model ready for future PDF page image rendering in `data/page-images`.
- PWA manifest/service worker foundation for iPhone Home Screen support later.
- Truck number prompt at startup and unit notes for symptoms, readings, repair history, and attached photos.

## Run it

Double-click `Start-830Guru.bat`, or run:

```powershell
node server.js
```

Then open:

```text
http://localhost:8300
```

## Configure AI

Copy `.env.example` to `.env` and add your API key:

```text
OPENAI_API_KEY=your_key_here
OPENAI_MODEL=gpt-5.2
PORT=8300
APP_PASSWORD=
```

Restart the server after changing `.env`.

Set `APP_PASSWORD` before exposing the app on the internet. The app uses browser Basic Auth when that variable is present.

## Hosting Notes

Do not publish `.env`, PDFs, extracted `data/index.json`, page thumbnails, photos, or notes to a public repository. The app intentionally ignores those files for GitHub.

GitHub is good for storing the app source, but GitHub Pages cannot run this Node server securely because the OpenAI API key must stay server-side. To use the app anywhere, deploy the Node app to a private host such as Render, Railway, Fly.io, a VPS, or a private company server, then upload/index the manuals on that host.

Recommended deployment shape:

1. Private GitHub repository for source code.
2. Cloud/server environment variable `OPENAI_API_KEY`.
3. Cloud/server environment variable `APP_PASSWORD`.
4. Private storage for manuals and generated index data.
5. Login/password or VPN before exposing it outside your PC.

This repo includes a `Dockerfile` and `render.yaml` for hosting on Render or a similar Docker host. After deployment, upload the manuals to the server's `data/manuals` folder and run the indexer there, or use a private persistent disk/volume containing `data/manuals` and `data/index.json`.

## Add manuals

Use the app's Documents panel to add PDFs, or place files directly in:

```text
data/manuals
```

The current manual set has been indexed:

- `ShopManual.pdf` - 1,143 pages
- `OperationMaintanence.pdf` - 31 pages
- `PartsBook.pdf` - 606 pages
- `QSK60PartsBook.pdf` - 176 pages

After adding or replacing manuals, double-click `Reindex-Manuals.bat` to rebuild `data/index.json`.

The current policy is strict: if a provided source page is not found, the assistant should say that instead of guessing.

Page thumbnails are generated on demand and cached in `data/page-images`.

## Recommended direction

For the goal you described, the right architecture is:

1. Local document vault for your provided 830E-1AC manuals, schematics, parts books, and service bulletins.
2. OCR only for any pages that do not extract clean text.
3. Better retrieval ranking for exact fault-code numbers, torque tables, pressure test points, and procedures.
4. Answer guardrails: cite sources, show confidence, avoid guessing, and warn on safety-critical procedures.
5. Mobile-ready PWA first, native iPhone app later only if needed.
6. Offline-first path if possible. For truly offline AI, add a local model backend later; for best accuracy and speed, an API key can be added later in `.env`.

That path is better than fine-tuning at the start. The manuals will change, page citations matter, and retrieval lets you inspect every answer back to the source.
