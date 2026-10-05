const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { transliterate } = require('transliteration');
const sanitize = require('sanitize-filename');
const { convertComicToPdf } = require('./comic-converter');

const app = express();
const PORT = process.env.PORT || 3002;
const KEY_LENGTH = 4;
const KEY_CHARS = '23456789ACDEFGHJKLMNPRSTUVWXYZ';
const EXPIRE_DELAY_MS = 30 * 1000;
const MAX_EXPIRE_MS = 60 * 60 * 1000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');

const TYPE_EPUB = 'application/epub+zip';
const TYPE_MOBI = 'application/x-mobipocket-ebook';
const allowedTypes = [TYPE_EPUB, TYPE_MOBI, 'application/pdf', 'application/vnd.comicbook+zip', 'application/vnd.comicbook-rar', 'text/html', 'text/plain', 'application/zip', 'application/x-rar-compressed'];
const allowedExtensions = ['epub', 'mobi', 'pdf', 'cbz', 'cbr', 'html', 'txt'];

const keyStore = new Map();

function ensureUploadFolder() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

function doTransliterate(filename) {
  const parts = filename.split('.');
  const ext = `.${parts.pop()}`;
  return `${transliterate(parts.join('.'))}${ext}`;
}

function randomKey() {
  const max = Math.pow(KEY_CHARS.length, KEY_LENGTH);
  const random = Math.floor(Math.random() * max);
  return random.toString(KEY_CHARS.length).padStart(KEY_LENGTH, '0')
    .split('')
    .map((chr) => KEY_CHARS[Number.parseInt(chr, KEY_CHARS.length)])
    .join('');
}

function removeKey(key) {
  const info = keyStore.get(key);
  if (!info) return;

  if (info.timer) clearTimeout(info.timer);
  if (info.file && info.file.path) {
    fs.unlink(info.file.path, (err) => {
      if (err) console.error('Failed to delete temp file', err);
    });
  }

  keyStore.delete(key);
}

function expireKey(key) {
  const info = keyStore.get(key);
  if (!info) return;

  const timer = setTimeout(() => removeKey(key), EXPIRE_DELAY_MS);
  if (info.timer) clearTimeout(info.timer);
  info.timer = timer;
  info.alive = new Date();
}

function detectDevice(agent = '') {
  const normalized = (agent || '').toLowerCase();
  if (normalized.includes('kindle')) return 'Kindle';
  if (normalized.includes('kobo')) return 'Kobo';
  if (normalized.includes('tolino')) return 'Tolino';
  return 'Unknown';
}

async function runConversion(command, args, inputPath, outputPath, errorLabel) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: path.dirname(inputPath) });
    let stderr = '';

    child.on('error', (err) => {
      reject(`${errorLabel}: ${err.message}`);
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.stdout.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(`${errorLabel} exited with code ${code}: ${stderr}`);
        return;
      }

      resolve(outputPath);
    });
  });
}

function baseUploadConfig() {
  return multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
      filename: (_req, file, cb) => {
        const uniqueSuffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        cb(null, `${file.fieldname}-${uniqueSuffix}${path.extname(file.originalname).toLowerCase()}`);
      }
    }),
    limits: { fileSize: 800 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, cb) => {
      file.originalname = sanitize(Buffer.from(file.originalname, 'latin1').toString('utf8'));
      const ext = path.extname(file.originalname.toLowerCase()).slice(1);
      const isMimeAllowed = allowedTypes.includes(file.mimetype) || file.mimetype === 'application/octet-stream';
      const isExtAllowed = allowedExtensions.includes(ext);
      if (!isMimeAllowed || !isExtAllowed) {
        return cb(new Error(`Invalid file type: ${file.originalname}`));
      }
      cb(null, true);
    }
  });
}

const upload = baseUploadConfig();

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, status: 'ready' });
});

app.get('/api/device', (req, res) => {
  const device = detectDevice(req.headers['user-agent'] || '');
  res.json({ device, isEreader: device !== 'Unknown' });
});

app.post('/api/generate', (req, res) => {
  const agent = req.headers['user-agent'] || 'unknown';
  if (detectDevice(agent) === 'Unknown') {
    return res.status(403).send('reader_required');
  }

  let key = ''; 
  let attempts = 0;

  do {
    key = randomKey();
    attempts += 1;
    if (attempts > 1000) {
      return res.status(500).send('error');
    }
  } while (keyStore.has(key));

  keyStore.set(key, {
    created: new Date(),
    agent,
    urls: [],
    file: null,
    alive: new Date()
  });

  expireKey(key);

  const timeout = setTimeout(() => {
    if (keyStore.get(key) && keyStore.get(key).file === null) {
      removeKey(key);
    }
  }, MAX_EXPIRE_MS);

  const info = keyStore.get(key);
  info.maxTimer = timeout;

  res.send(key);
});

app.get('/api/status/:key', (req, res) => {
  const key = req.params.key.toUpperCase();
  const info = keyStore.get(key);

  if (!info) {
    return res.status(404).json({ error: 'Unknown key' });
  }

  expireKey(key);
  res.json({
    alive: info.alive,
    file: info.file ? { name: info.file.name } : null,
    urls: info.urls || []
  });
});

app.get('/download/:filename', (req, res) => {
  const key = (req.query.key || '').toUpperCase();
  const filename = decodeURIComponent(req.params.filename);
  const info = keyStore.get(key);

  if (!info || !info.file || info.file.name !== filename) {
    return res.status(404).send('File not found');
  }

  if (info.agent !== (req.headers['user-agent'] || '')) {
    if (!req.headers['user-agent'] || !info.agent.includes(req.headers['user-agent'] || '')) {
      console.warn('User agent mismatch for key', key);
    }
  }

  expireKey(key);
  res.download(info.file.path, info.file.name);
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
  const key = (req.body.key || '').toUpperCase();
  const info = keyStore.get(key);

  if (!info) {
    if (req.file) {
      fs.unlink(req.file.path, () => {});
    }
    return res.status(400).json({ success: false, message: `Unknown key ${key}` });
  }

  expireKey(key);

  let url = null;
  if (req.body.url && req.body.url.trim()) {
    url = req.body.url.trim();
    if (!info.urls.includes(url)) {
      info.urls.push(url);
    }
  }

  const comicMode = (req.body.comicMode || (req.body.panelByPanel ? 'panel' : 'bd')).toLowerCase();
  const panelByPanel = comicMode === 'panel';

  let filePath = null;
  let filename = '';
  let conversion = null;

  if (req.file) {
    if (req.file.size === 0) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ success: false, message: 'Invalid file submitted (empty file)' });
    }

    const mimetype = req.file.mimetype;
    const ext = path.extname(req.file.originalname).toLowerCase().slice(1);

    if (mimetype === 'application/epub') {
      // normalize Kindle-formatted EPUB MIME type
    }

    if (!allowedTypes.includes(mimetype) && !(mimetype === 'application/octet-stream' && allowedExtensions.includes(ext))) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ success: false, message: `Uploaded file is of an invalid type: ${req.file.originalname}` });
    }

    if (panelByPanel && !['cbz', 'cbr'].includes(ext)) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ success: false, message: 'Panel-by-panel conversion requires a CBZ or CBR comic archive.' });
    }

    filename = req.file.originalname;
    if (req.body.transliteration === 'true' || req.body.transliteration === 'on') {
      filename = sanitize(doTransliterate(filename));
    }

    if (detectDevice(info.agent) === 'Kindle') {
      filename = filename.replace(/[^\.\w\-"'\(\)]/g, '_');
    }

    try {
      if (['cbz', 'cbr'].includes(ext) && (comicMode === 'bd' || panelByPanel)) {
        const outPath = req.file.path.replace(/\.(cbz|cbr)$/i, '.pdf');
        await convertComicToPdf(req.file.path, outPath, req.body.readerProfile, req.body.customWidth, req.body.customHeight, { layoutMode: comicMode });
        filePath = outPath;
        filename = filename.replace(/\.(cbz|cbr)$/i, '.pdf');
        conversion = comicMode === 'bd' ? 'BD-mode PDF conversion' : 'panel-by-panel PDF conversion';
        fs.unlink(req.file.path, () => {});
      } else if (mimetype === TYPE_EPUB && detectDevice(info.agent) === 'Kindle' && req.body.kindlegen === 'true') {
        const outPath = req.file.path.replace(/\.epub$/i, '.mobi');
        const outputName = filename.replace(/\.kepub\.epub$/i, '.epub').replace(/\.epub$/i, '.mobi');
        await runConversion('kindlegen', [path.basename(req.file.path), '-dont_append_source', '-c1', '-o', path.basename(outPath)], req.file.path, outPath, 'KindleGen');
        filePath = outPath;
        filename = outputName;
        conversion = 'KindleGen';
        fs.unlink(req.file.path, () => {});
      } else if (mimetype === TYPE_EPUB && detectDevice(info.agent) === 'Kobo' && req.body.kepubify === 'true') {
        const outPath = req.file.path.replace(/\.epub$/i, '.kepub.epub');
        const outputName = filename.replace(/\.kepub\.epub$/i, '.epub').replace(/\.epub$/i, '.kepub.epub');
        await runConversion('kepubify', ['-v', '-u', '-o', path.basename(outPath), path.basename(req.file.path)], req.file.path, outPath, 'Kepubify');
        filePath = outPath;
        filename = outputName;
        conversion = 'Kepubify';
        fs.unlink(req.file.path, () => {});
      } else if (mimetype === 'application/pdf' && req.body.pdfcropmargins === 'true') {
        const outPath = path.join(path.dirname(req.file.path), `${path.basename(req.file.path, '.pdf')}_cropped.pdf`);
        await runConversion('pdfcropmargins', ['-s', '-u', '-o', outPath, path.basename(req.file.path)], req.file.path, outPath, 'pdfCropMargins');
        filePath = outPath;
        filename = filename.replace(/\.pdf$/i, '_cropped.pdf');
        conversion = 'pdfCropMargins';
        fs.unlink(req.file.path, () => {});
      } else {
        filePath = req.file.path;
        filename = filename.replace(/\.epub$/i, '.epub').replace(/\.pdf$/i, '.pdf');
      }
    } catch (err) {
      if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
      return res.status(400).json({ success: false, message: String(err) });
    }

    if (info.file && info.file.path) {
      try {
        fs.unlinkSync(info.file.path);
      } catch (error) {
        console.warn('Could not delete previous file', error);
      }
    }

    info.file = {
      name: filename,
      path: filePath,
      uploaded: new Date()
    };
  }

  if (!req.file && !url) {
    return res.status(400).json({ success: false, message: 'No file or URL selected' });
  }

  const messages = [];
  if (req.file) {
    const deviceLabel = detectDevice(info.agent);
    messages.push(`Upload successful! ${conversion ? `Ebook was converted with ${conversion} and sent` : 'Sent'} to ${deviceLabel === 'Kobo' ? 'a Kobo device.' : deviceLabel === 'Kindle' ? 'a Kindle device.' : 'a device.'}`);
    messages.push(`Filename: ${filename}`);
  }
  if (url) {
    messages.push(`Added url: ${url}`);
  }

  res.json({ success: true, message: messages.join(' '), key });
});

app.get('/api/receive', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

ensureUploadFolder();

app.listen(PORT, () => {
  console.log(`send2ereader-web running on http://localhost:${PORT}`);
});
