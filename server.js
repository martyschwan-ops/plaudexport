const express = require('express');
const axios = require('axios');
const archiver = require('archiver');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const REGIONS = {
  us: 'https://api.plaud.ai',
  eu: 'https://api-euc1.plaud.ai',
};

// Single-user in-memory session
let session = { token: null, region: 'us' };

function apiBase() {
  return REGIONS[session.region] || REGIONS.us;
}

function authHeaders() {
  return {
    Authorization: `Bearer ${session.token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

function sanitize(name) {
  return (name || 'untitled')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim() || 'untitled';
}

function formatDuration(seconds) {
  if (!seconds) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

app.post('/api/login', async (req, res) => {
  const { email, password, region = 'us' } = req.body;
  const base = REGIONS[region] || REGIONS.us;
  try {
    const params = new URLSearchParams({ username: email, password });
    const { data } = await axios.post(`${base}/auth/access-token`, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000,
    });
    if (data.status === 0 && data.access_token) {
      session = { token: data.access_token, region };
      res.json({ ok: true });
    } else {
      res.status(401).json({ error: 'Invalid credentials' });
    }
  } catch (err) {
    const detail = err.response?.data?.detail || err.message;
    res.status(401).json({ error: `Login failed: ${detail}` });
  }
});

app.post('/api/logout', (_req, res) => {
  session = { token: null, region: 'us' };
  res.json({ ok: true });
});

// ── User ──────────────────────────────────────────────────────────────────────

app.get('/api/me', async (_req, res) => {
  if (!session.token) return res.status(401).json({ error: 'Not logged in' });
  try {
    const { data } = await axios.get(`${apiBase()}/user/me`, {
      headers: authHeaders(),
      timeout: 10000,
    });
    res.json(data);
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// ── Recordings ────────────────────────────────────────────────────────────────

app.get('/api/recordings', async (_req, res) => {
  if (!session.token) return res.status(401).json({ error: 'Not logged in' });
  try {
    const { data } = await axios.get(`${apiBase()}/file/simple/web`, {
      headers: authHeaders(),
      timeout: 30000,
    });
    const files = (data.data_file_list || [])
      .filter((f) => !f.is_trash)
      .map((f) => ({
        id: f.file_id || f.id,
        name: f.file_name || f.filename || f.fullname || 'Untitled',
        fullname: f.fullname,
        duration: f.duration,
        start_time: f.start_time,
        filesize: f.filesize,
        is_trans: f.is_trans,
        is_summary: f.is_summary,
        serial_number: f.serial_number,
      }));
    res.json(files);
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// ── Export ZIP ────────────────────────────────────────────────────────────────

app.post('/api/export', async (req, res) => {
  if (!session.token) return res.status(401).json({ error: 'Not logged in' });

  const { ids = [], includeTranscript = true, includeAudio = false } = req.body;
  if (!ids.length) return res.status(400).json({ error: 'No recordings selected' });

  const timestamp = new Date().toISOString().split('T')[0];
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="plaud-export-${timestamp}.zip"`
  );

  const archive = archiver('zip', { zlib: { level: 6 } });

  archive.on('error', (err) => {
    console.error('Archive error:', err);
    if (!res.headersSent) res.status(500).end();
  });

  archive.pipe(res);

  for (const id of ids) {
    try {
      const { data: detail } = await axios.get(`${apiBase()}/file/detail/${id}`, {
        headers: authHeaders(),
        timeout: 20000,
      });

      const name = sanitize(
        detail.file_name || detail.filename || detail.fullname || id
      );
      const date = detail.start_time
        ? new Date(detail.start_time).toISOString().split('T')[0]
        : 'unknown';
      const folder = `${date} - ${name}`;

      if (includeTranscript) {
        const items = detail.pre_download_content_list || [];
        const transcriptBody = items
          .map((i) => i.data_content || '')
          .filter(Boolean)
          .join('\n\n');

        const summary = detail.data_summary || detail.summary || '';

        const lines = [
          `Title: ${detail.file_name || detail.filename || id}`,
          `Date: ${date}`,
          `Duration: ${formatDuration(detail.duration)}`,
        ];
        if (detail.serial_number) lines.push(`Device: ${detail.serial_number}`);
        lines.push('');

        let content = lines.join('\n');

        if (summary) {
          content += `${'─'.repeat(60)}\nSUMMARY\n${'─'.repeat(60)}\n${summary}\n\n`;
        }

        if (transcriptBody) {
          content += `${'─'.repeat(60)}\nTRANSCRIPT\n${'─'.repeat(60)}\n${transcriptBody}\n`;
        } else {
          content += '(No transcript available)\n';
        }

        archive.append(content, { name: `${folder}/transcript.txt` });
      }

      if (includeAudio) {
        try {
          const { data: urlData } = await axios.get(
            `${apiBase()}/file/temp-url/${id}?is_opus=false`,
            { headers: authHeaders(), timeout: 15000 }
          );
          const audioUrl =
            urlData.url ||
            urlData?.data?.url ||
            urlData?.data ||
            urlData?.temp_url;

          if (audioUrl) {
            const audioStream = await axios.get(audioUrl, {
              responseType: 'stream',
              timeout: 300000, // 5 min for large files
            });
            archive.append(audioStream.data, { name: `${folder}/audio.mp3` });
            // Wait for stream to be consumed before moving on
            await new Promise((resolve, reject) => {
              audioStream.data.on('end', resolve);
              audioStream.data.on('error', reject);
            });
          }
        } catch (audioErr) {
          console.warn(`Audio unavailable for ${id}:`, audioErr.message);
          archive.append(`Audio export failed: ${audioErr.message}\n`, {
            name: `${folder}/audio-error.txt`,
          });
        }
      }
    } catch (err) {
      console.warn(`Failed to process recording ${id}:`, err.message);
      archive.append(`Export failed: ${err.message}\n`, {
        name: `failed/${id}.txt`,
      });
    }
  }

  await archive.finalize();
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  Plaud Exporter → http://localhost:${PORT}\n`);
});
