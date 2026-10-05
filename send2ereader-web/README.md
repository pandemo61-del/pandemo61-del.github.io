# send2ereader-web

A self-hosted web app for sending ebooks and comics from a browser to a Kindle or Kobo. Transfers use a temporary four-character code: open the app on the e-reader to get a code, then enter it on the device sending the file.

## Features

- Detect Kindle and Kobo browsers and automatically generate a receiving code
- Send EPUB, MOBI, PDF, TXT, CBZ, and CBR files, or add a URL
- Download the file on the e-reader when it is ready
- Optionally convert EPUB to MOBI for Kindle or EPUB to Kepub for Kobo
- Convert CBZ/CBR archives to PDFs sized for the e-reader resolution
- Two comic reading modes:
  - **BD mode** groups detected panels for a more natural comic reading experience and avoids cutting through panels
  - **Panel mode** places detected panels on separate PDF pages
- Remove small page numbers detected in the bottom margin of comic pages
- Choose a preset Kobo or Kindle profile, or enter a custom resolution for comic PDFs
- Optionally crop PDF margins

## Requirements

- Node.js and npm
- For the corresponding conversions, install these tools and make sure they are available on your `PATH`:
  - `kepubify` for Kobo
  - `kindlegen` for Kindle
  - `pdfcropmargins` for PDF cropping

CBZ/CBR-to-PDF conversion is handled by the app. Its required dependencies are installed with npm.

## Install and run

```bash
npm install
npm start
```

The app listens on port `3002` by default. To use a different port:

```bash
PORT=8080 npm start
```

In PowerShell:

```powershell
$env:PORT = 8080
npm start
```

Then open `http://localhost:3002` (or the configured port) on both devices. For development with automatic restarts:

```bash
npm run dev
```

## Send a file

1. Open the app in the e-reader browser; it will generate a receiving code.
2. Open the app on the device that has the book.
3. Enter the code, select a file or add a URL, then send it.
4. When the file is ready, open its link on the e-reader.

Conversion options and the e-reader profile are available under **Conversion and file options**. Preferences are saved in a browser cookie.

## Limitations and hosting

- The maximum upload size is 800 MB.
- Pairing codes, their state, and pending files are managed temporarily by the Node.js server. Restarting the server clears the codes and in-memory state.
- Uploaded files are stored in `uploads/`; this directory is excluded from Git.
- This app requires a Node.js server and cannot run as a static GitHub Pages site alone.
- Before exposing the server to the internet, configure hosting and protections appropriate for your use.

## Sync to the presentation repository

The `Sync project to presentation site` workflow copies the tracked files from this repository to `send2ereader-web/` in [`pandemo61-del/pandemo61-del.github.io`](https://github.com/pandemo61-del/pandemo61-del.github.io) whenever changes are pushed to `main`. It can also be started manually from the Actions tab. The sync replaces the contents of that destination folder; files elsewhere in the presentation repository are not changed.

To authorize the cross-repository push, create a fine-grained personal access token with **Contents: Read and write** access to `pandemo61-del/pandemo61-del.github.io`, then add it to this repository's Actions secrets as `PRESENTATION_REPO_TOKEN`.

This workflow only synchronizes the project source. GitHub Pages cannot run its Node.js server, so the app's upload, pairing, and conversion features still require a separately hosted Node.js backend.

## API

- `GET /api/health` — server health
- `GET /api/device` — detect the browser device type
- `POST /api/generate` — create a receiving code on an e-reader
- `GET /api/status/:key` — check transfer status and retrieve the file link
- `POST /api/upload` — upload a file or add a URL
- `GET /download/:filename?key=:key` — download the file on the e-reader
