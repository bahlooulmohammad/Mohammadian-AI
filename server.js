require('dotenv').config();

const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;

const DATA_ROOT = process.env.VERCEL
  ? path.join('/tmp', 'mohammadian-ai')
  : ROOT;

const UPLOADS = path.join(DATA_ROOT, 'uploads');
const DB = path.join(DATA_ROOT, 'data', 'queue.json');

const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`)
  .replace(/\/$/, '');

fs.mkdirSync(UPLOADS, { recursive: true });
fs.mkdirSync(path.dirname(DB), { recursive: true });

if (!fs.existsSync(DB)) {
  fs.writeFileSync(DB, '[]');
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));

app.use(session({
  name: 'mohammadian.sid',
  secret: process.env.SESSION_SECRET || 'local-dev-change-this-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'strict',
    secure: APP_URL.startsWith('https://'),
    maxAge: 12 * 60 * 60 * 1000
  }
}));

app.use('/uploads', express.static(UPLOADS, { maxAge: '1h' }));
app.use(express.static(path.join(ROOT, 'public')));

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOADS),
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname)
      .toLowerCase()
      .replace(/[^.a-z0-9]/g, '') || '.mp4';

    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 9)}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 250 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    cb(null, /^video\/(mp4|quicktime|x-m4v)$/.test(file.mimetype));
  }
});

function readItems() {
  try {
    return JSON.parse(fs.readFileSync(DB, 'utf8'));
  } catch {
    return [];
  }
}

function writeItems(items) {
  fs.writeFileSync(DB, JSON.stringify(items, null, 2));
}

function auth(req, res, next) {
  if (req.session?.ok) return next();
  return res.status(401).json({ error: 'ابتدا وارد پنل شوید.' });
}

app.post('/api/login', (req, res) => {
  const expected = process.env.ADMIN_PASSWORD;

  if (!expected || expected.length < 10) {
    return res.status(503).json({
      error: 'رمز پنل را در تنظیمات محیطی وارد کنید.'
    });
  }

  if ((req.body.password || '') !== expected) {
    return res.status(401).json({ error: 'رمز پنل اشتباه است.' });
  }

  req.session.ok = true;
  res.json({ ok: true });
});

app.post('/api/logout', auth, (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  res.json({ loggedIn: !!req.session?.ok });
});

app.get('/api/status', auth, (_, res) => {
  res.json({
    mode: 'manual-share',
    dailyTarget: 1,
    reminderTime: '20:00',
    timezone: process.env.TIMEZONE || 'Europe/Berlin',
    queue: readItems()
  });
});

app.get('/api/queue', auth, (_, res) => {
  res.json(readItems());
});

/* جستجوی کلیپ اسکانیا و کلیپ‌های کوردی */
app.get('/api/auto-pick', auth, async (req, res) => {
  try {
    const category = String(req.query.category || 'scania');

    const searches = {
      scania: [
        'Scania truck filemime:video',
        'Scania lorry filemime:video',
        'Scania S500 filemime:video',
        'Scania truck driving filemime:video'
      ],

      kurdish: [
        'Kurdish music filemime:video',
        'Kurdish culture filemime:video',
        'Kurdish dance filemime:video',
        'Kurdistan filemime:video',
        'Kurdish festival filemime:video'
      ],

      'kurdish-scania': [
        'Kurdish Scania truck filemime:video',
        'Kurdistan truck filemime:video',
        'Scania Kurdistan filemime:video'
      ]
    };

    if (!searches[category]) {
      return res.status(400).json({
        error: 'دسته‌بندی انتخاب‌شده معتبر نیست.'
      });
    }

    const allVideos = [];

    for (const searchText of searches[category]) {
      const params = new URLSearchParams({
        action: 'query',
        generator: 'search',
        gsrsearch: searchText,
        gsrnamespace: '6',
        gsrlimit: '30',
        prop: 'imageinfo',
        iiprop: 'url|extmetadata',
        format: 'json'
      });

      const response = await fetch(
        `https://commons.wikimedia.org/w/api.php?${params}`,
        {
          headers: {
            'User-Agent': 'MohammadianAI/1.0'
          }
        }
      );

      if (!response.ok) continue;

      const data = await response.json();
      const pages = Object.values(data.query?.pages || {});

      for (const page of pages) {
        const info = page.imageinfo?.[0];
        if (!info?.url) continue;

        const meta = info.extmetadata || {};
        const license = meta.LicenseShortName?.value || '';

        const isVideo = /\.(webm|ogv|ogg|mp4)$/i.test(info.url);

        const allowedLicense =
          /CC BY(?:-SA)?(?:\s|$)|CC0|Public domain/i.test(license);

        if (isVideo && allowedLicense) {
          allVideos.push({
            page,
            info,
            license,
            meta
          });
        }
      }
    }

    const unique = [
      ...new Map(
        allVideos.map(item => [item.info.url, item])
      ).values()
    ];

    if (!unique.length) {
      return res.status(404).json({
        error: 'کلیپ دارای مجوز قابل قبول پیدا نشد. می‌توانیم ایده اختصاصی بسازیم.'
      });
    }

    const selected = unique[
      Math.floor(Math.random() * unique.length)
    ];

    const { page, info, license, meta } = selected;

    res.json({
      title: page.title,
      videoUrl: info.url,
      sourceUrl: info.descriptionurl,
      license,
      author: meta.Artist?.value || '',
      licenseUrl: meta.LicenseUrl?.value || '',
      attributionRequired: true,
      category,
      totalFound: unique.length
    });

  } catch (error) {
    console.error('Auto pick error:', error);

    res.status(500).json({
      error: 'جستجوی خودکار انجام نشد. دوباره تلاش کنید.'
    });
  }
});

app.post('/api/upload', auth, upload.single('video'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      error: 'فایل MP4 یا MOV انتخاب کنید.'
    });
  }

  res.json({
    videoUrl: `${APP_URL}/uploads/${encodeURIComponent(req.file.filename)}`,
    filename: req.file.filename
  });
});

app.post('/api/queue', auth, (req, res) => {
  const b = req.body || {};

  if (!b.videoUrl || !/^https?:\/\//i.test(b.videoUrl)) {
    return res.status(400).json({
      error: 'ویدئو را بارگذاری کنید یا لینک مستقیم عمومی وارد کنید.'
    });
  }

  if (!b.scheduledAt || Number.isNaN(Date.parse(b.scheduledAt))) {
    return res.status(400).json({
      error: 'زمان یادآوری معتبر نیست.'
    });
  }

  if (!String(b.licenseNote || '').trim()) {
    return res.status(400).json({
      error: 'منبع و مدرک اجازه بازنشر را وارد کنید.'
    });
  }

  const items = readItems();

  const item = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    title: String(b.title || 'ریلز جدید').slice(0, 120),
    caption: String(b.caption || '').slice(0, 2200),
    videoUrl: String(b.videoUrl).slice(0, 2000),
    sourceUrl: String(b.sourceUrl || '').slice(0, 2000),
    licenseNote: String(b.licenseNote).slice(0, 1000),
    scheduledAt: new Date(b.scheduledAt).toISOString(),
    status: 'ready_for_review',
    createdAt: new Date().toISOString()
  };

  items.push(item);
  writeItems(items);
  res.json(item);
});

app.patch('/api/queue/:id', auth, (req, res) => {
  const items = readItems();
  const item = items.find(x => x.id === req.params.id);

  if (!item) {
    return res.status(404).json({ error: 'مورد پیدا نشد.' });
  }

  if (req.body.status &&
      ['ready_for_review', 'shared', 'archived'].includes(req.body.status)) {
    item.status = req.body.status;
  }

  if (req.body.caption !== undefined) {
    item.caption = String(req.body.caption).slice(0, 2200);
  }

  writeItems(items);
  res.json(item);
});

app.delete('/api/queue/:id', auth, (req, res) => {
  const items = readItems();
  const next = items.filter(x => x.id !== req.params.id);

  if (next.length === items.length) {
    return res.status(404).json({ error: 'مورد پیدا نشد.' });
  }

  writeItems(next);
  res.json({ ok: true });
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Mohammadian AI running on ${PORT}`);
  });
}

module.exports = app;
