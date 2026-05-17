const express = require('express');
const axios = require('axios');
const archiver = require('archiver');
const zlib = require('zlib');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const REGIONS = {
  us: 'https://api.plaud.ai',
  eu: 'https://api-euc1.plaud.ai',
};

const CONFIG_PATH = path.join(os.homedir(), '.plaud-exporter.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(data) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), { mode: 0o600 });
}

const saved = loadConfig();
let session = { token: saved.token || null, region: saved.region || 'us' };

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

function formatDuration(ms) {
  if (!ms) return '';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// Fetch a URL and decompress if gzipped
async function fetchContent(url) {
  const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
  const buf = Buffer.from(resp.data);
  // Detect gzip magic bytes
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    return new Promise((resolve, reject) => {
      zlib.gunzip(buf, (err, result) => {
        if (err) reject(err);
        else resolve(result.toString('utf8'));
      });
    });
  }
  return buf.toString('utf8');
}

// Parse Plaud's transcript JSON into readable text
function parseTranscriptJson(json) {
  let segments = null;
  if (Array.isArray(json)) {
    segments = json;
  } else if (json.utterances) {
    segments = json.utterances;
  } else if (json.segments) {
    segments = json.segments;
  } else if (typeof json.transcript === 'string') {
    return json.transcript;
  }

  if (!segments) return JSON.stringify(json, null, 2);

  return segments.map((seg) => {
    const rawSpeaker = seg.speaker ?? seg.speaker_id;
    const speaker = rawSpeaker !== undefined && rawSpeaker !== null
      ? `Speaker ${rawSpeaker}`
      : null;
    const text = seg.text || seg.transcript || seg.content || '';
    if (!text) return null;
    return speaker ? `[${speaker}] ${text}` : text;
  }).filter(Boolean).join('\n');
}

// Extract the AI summary markdown from pre_download_content_list
function extractSummary(preList) {
  const parts = [];
  for (const item of preList) {
    if (!item.data_content) continue;
    try {
      const parsed = JSON.parse(item.data_content);
      if (parsed.ai_content) {
        // Strip embedded image references (![...](...))
        const text = parsed.ai_content.replace(/!\[.*?\]\(.*?\)\n*/g, '').trim();
        if (text) parts.push(text);
      }
    } catch {
      parts.push(item.data_content);
    }
  }
  return parts.join('\n\n');
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
      saveConfig(session);
      res.json({ ok: true });
    } else {
      res.status(401).json({ error: 'Invalid credentials' });
    }
  } catch (err) {
    const detail = err.response?.data?.detail || err.message;
    res.status(401).json({ error: `Login failed: ${detail}` });
  }
});

app.post('/api/login-token', async (req, res) => {
  const { token, region = 'us' } = req.body;
  if (!token) return res.status(400).json({ error: 'Token is required' });
  const base = REGIONS[region] || REGIONS.us;
  try {
    await axios.get(`${base}/user/me`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      timeout: 10000,
    });
    session = { token, region };
    saveConfig(session);
    res.json({ ok: true });
  } catch (err) {
    const status = err.response?.status;
    if (status === 401 || status === 403) {
      res.status(401).json({ error: 'Token rejected by Plaud — it may have expired.' });
    } else {
      res.status(401).json({ error: `Could not verify token: ${err.message}` });
    }
  }
});

app.post('/api/logout', (_req, res) => {
  session = { token: null, region: 'us' };
  saveConfig({});
  res.json({ ok: true });
});

app.get('/api/session', (_req, res) => {
  res.json({ active: !!session.token });
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
    const allFiles = [];
    let page = 1;
    const pageSize = 100;

    while (true) {
      const { data } = await axios.get(`${apiBase()}/file/simple/web`, {
        headers: authHeaders(),
        params: { page, page_size: pageSize },
        timeout: 30000,
      });

      // Plaud returns HTTP 200 with a status field in the body for errors
      if (data.status !== undefined && data.status !== 0) {
        const msg = data.msg || `API error ${data.status}`;
        const isExpired = data.status === -419 || /expired|unauthorized/i.test(msg);
        return res.status(isExpired ? 401 : 502).json({ error: isExpired ? 'Session expired — please log out and sign in again.' : msg });
      }

      // Handle both flat and wrapped response shapes:
      //   { data_file_list: [...] }
      //   { status, data: { data_file_list: [...] } }
      const payload = data.data_file_list ? data : (data.data || {});
      const batch = payload.data_file_list || [];

      allFiles.push(...batch);

      // Stop if we got fewer results than the page size (last page)
      if (batch.length < pageSize) break;
      page++;
    }

    const files = allFiles
      .filter((f) => !f.is_trash)
      .map((f) => ({
        id: f.file_id || f.id,
        name: f.file_name || f.filename || f.fullname || 'Untitled',
        duration: f.duration,
        start_time: f.start_time,
        filesize: f.filesize,
        is_trans: f.is_trans,
        is_summary: f.is_summary,
      }));
    res.json(files);
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// ── Debug ─────────────────────────────────────────────────────────────────────

app.get('/api/debug/recordings-raw', async (_req, res) => {
  if (!session.token) return res.status(401).json({ error: 'Not logged in' });
  try {
    const { data } = await axios.get(`${apiBase()}/file/simple/web`, {
      headers: authHeaders(),
      params: { page: 1, page_size: 5 },
      timeout: 30000,
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message, response: err.response?.data });
  }
});

app.get('/api/debug/:id', async (req, res) => {
  if (!session.token) return res.status(401).json({ error: 'Not logged in' });
  try {
    const { data } = await axios.get(`${apiBase()}/file/detail/${req.params.id}`, {
      headers: authHeaders(),
      timeout: 20000,
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Export ZIP ────────────────────────────────────────────────────────────────

app.post('/api/export', async (req, res) => {
  if (!session.token) return res.status(401).json({ error: 'Not logged in' });

  const { ids = [], includeTranscript = true, includeAudio = false } = req.body;
  if (!ids.length) return res.status(400).json({ error: 'No recordings selected' });

  const timestamp = new Date().toISOString().split('T')[0];
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="plaud-export-${timestamp}.zip"`);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', (err) => {
    console.error('Archive error:', err);
    if (!res.headersSent) res.status(500).end();
  });
  archive.pipe(res);

  for (const id of ids) {
    try {
      const { data: raw } = await axios.get(`${apiBase()}/file/detail/${id}`, {
        headers: authHeaders(),
        timeout: 20000,
      });

      // API wraps response: { status, data: { file_id, file_name, content_list, ... } }
      const detail = raw.data || raw;

      const name = sanitize(detail.file_name || detail.filename || id);
      const date = detail.start_time
        ? new Date(detail.start_time).toISOString().split('T')[0]
        : 'unknown';
      const folder = `${date} - ${name}`;

      if (includeTranscript) {
        const header = [
          `Title: ${detail.file_name || id}`,
          `Date: ${date}`,
          `Duration: ${formatDuration(detail.duration)}`,
          '',
        ].join('\n');

        let transcriptText = '';
        let summaryText = '';

        // Fetch transcript from S3 (content_list entry with data_type 'transaction')
        const contentList = detail.content_list || [];
        const transItem = contentList.find((c) => c.data_type === 'transaction');
        if (transItem?.data_link) {
          try {
            const raw = await fetchContent(transItem.data_link);
            const json = JSON.parse(raw);
            transcriptText = parseTranscriptJson(json);
          } catch (e) {
            console.warn(`Transcript fetch failed for ${id}:`, e.message);
          }
        }

        // Extract summary from pre_download_content_list (already embedded in response)
        summaryText = extractSummary(detail.pre_download_content_list || []);

        let content = header;
        if (summaryText) {
          content += `${'─'.repeat(60)}\nSUMMARY\n${'─'.repeat(60)}\n${summaryText}\n\n`;
        }
        if (transcriptText) {
          content += `${'─'.repeat(60)}\nTRANSCRIPT\n${'─'.repeat(60)}\n${transcriptText}\n`;
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
          const audioUrl = urlData.url || urlData?.data?.url || urlData?.data || urlData?.temp_url;
          if (audioUrl) {
            const audioStream = await axios.get(audioUrl, {
              responseType: 'stream',
              timeout: 300000,
            });
            archive.append(audioStream.data, { name: `${folder}/audio.mp3` });
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
      archive.append(`Export failed: ${err.message}\n`, { name: `failed/${id}.txt` });
    }
  }

  await archive.finalize();
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  Plaud Exporter → http://localhost:${PORT}\n`);
});
