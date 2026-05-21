const https = require('https');
const http = require('http');
const crypto = require('crypto');
const PORT = process.env.PORT || 10000;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const DROPBOX_REFRESH_TOKEN = process.env.DROPBOX_REFRESH_TOKEN;
const DROPBOX_APP_KEY = process.env.DROPBOX_APP_KEY;
const DROPBOX_APP_SECRET = process.env.DROPBOX_APP_SECRET;

// =================== AUTH (Step 1) ===================
// Passwords live in Render env vars — never in code, never in browser source.
//
// Required env vars:
//   TEAM_PASSWORDS    "Faizan:faizan47,Sandesh:sandesh82,..."  (Name:password, comma-separated)
//   CLIENT_PASSWORDS  "jindal:Jindal2026,kotak:Kotak2026,adhoc:Adhoc2026,pitches:Pitches2026"
//   MASTER_PASSWORD   "Yellow@1234"   (founder + universal client unlock)
//   JWT_SECRET        "<random long string>"  (rotate to invalidate everyone's session)
const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE_ME_IN_RENDER_ENV';
const MASTER_PASSWORD = process.env.MASTER_PASSWORD || '';

function parseEnvMap(raw) {
  const out = {};
  (raw || '').split(',').forEach(pair => {
    const [k, v] = pair.split(':');
    if (k && v) out[k.trim()] = v.trim();
  });
  return out;
}
const TEAM_PASSWORDS   = parseEnvMap(process.env.TEAM_PASSWORDS);   // {Faizan:'faizan47',...}
const CLIENT_PASSWORDS = parseEnvMap(process.env.CLIENT_PASSWORDS); // {jindal:'Jindal2026',...}

const SESSION_DAYS = 7;

// =================== TELEGRAM NOTIFICATIONS ===================
// Required Render env vars:
//   TELEGRAM_BOT_TOKEN  → from @BotFather, e.g. "8528860335:AAGF..."
//   TELEGRAM_CHATS      → "Suriti:8751122054,Viplav:1234567,Faizan:9876543"
//                         The bot only sends to people listed here. New people
//                         need to register their Telegram ID first.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHATS     = parseEnvMap(process.env.TELEGRAM_CHATS); // {Suriti:'8751...', Viplav:'...'}

// Send a message to a specific Telegram chat ID via the Bot API
function sendTelegram(chatId, text) {
  if (!TELEGRAM_BOT_TOKEN || !chatId) return Promise.resolve({ ok: false, skipped: true });
  return new Promise((resolve) => {
    const body = JSON.stringify({
      chat_id: String(chatId),
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: false
    });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (r) => {
      let data = '';
      r.on('data', d => data += d);
      r.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve({ ok: false, parseError: true }); }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.write(body);
    req.end();
  });
}

// Resolve a "to" target (person name or "team") to chat IDs
function resolveChats(to) {
  if (!to) return [];
  if (to === 'team' || to === 'all') {
    // Broadcast to everyone registered
    return Object.entries(TELEGRAM_CHATS).map(([name, id]) => ({ name, id }));
  }
  const id = TELEGRAM_CHATS[to];
  return id ? [{ name: to, id }] : [];
}

// Sign a tamper-resistant token: <base64-payload>.<hmac-signature>
function signToken(payload) {
  const body = JSON.stringify({ ...payload, expires: Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000 });
  const b64 = Buffer.from(body).toString('base64url');
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

// Verify a token — returns payload if valid + unexpired, else null
function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [b64, sig] = token.split('.');
  if (!b64 || !sig) return null;
  const expected = crypto.createHmac('sha256', JWT_SECRET).update(b64).digest('base64url');
  if (sig !== expected) return null;
  try {
    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString());
    if (payload.expires && payload.expires < Date.now()) return null;
    return payload;
  } catch(e) { return null; }
}

// Cache access token
let cachedToken = null;
let tokenExpiry = 0;

async function getDropboxToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  
  const payload = `grant_type=refresh_token&refresh_token=${DROPBOX_REFRESH_TOKEN}&client_id=${DROPBOX_APP_KEY}&client_secret=${DROPBOX_APP_SECRET}`;
  
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.dropbox.com',
      path: '/oauth2/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(payload)
      }
    };
    const req = https.request(options, res => {
      let d = '';
      res.on('data', x => d += x);
      res.on('end', () => {
        try {
          const json = JSON.parse(d);
          if (json.access_token) {
            cachedToken = json.access_token;
            tokenExpiry = Date.now() + (json.expires_in - 300) * 1000; // refresh 5 min early
            console.log('Dropbox token refreshed successfully');
            resolve(cachedToken);
          } else {
            reject(new Error('No access token: ' + d));
          }
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// Ensure a Dropbox folder exists. Silently ignores "already exists" errors
// and any other failures — if it can't create, the subsequent move will surface
// the real error.
// Create one folder. Resolves whether it actually got created OR already existed
// OR errored — we don't distinguish, by design (idempotent ensure semantics).
function createOneFolder(token, folderPath) {
  return new Promise(resolve => {
    const payload = JSON.stringify({ path: folderPath, autorename: false });
    const options = {
      hostname: 'api.dropboxapi.com',
      path: '/2/files/create_folder_v2',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };
    const r = https.request(options, res => {
      let d = ''; res.on('data', x => d += x);
      res.on('end', () => resolve()); // success or "already exists" — both fine
    });
    r.on('error', () => resolve());
    r.write(payload); r.end();
  });
}

// Walks a path and ensures every level exists. Dropbox's create_folder_v2 requires
// the parent to already exist, so calling it once for '/Marico/Creatives' fails if
// /Marico hasn't been made yet. Walking the path solves that — for a brand-new
// client we create /Marico, then /Marico/Creatives, each step idempotent.
async function ensureFolder(token, folderPath) {
  if (!folderPath || folderPath === '/') return;
  const parts = folderPath.split('/').filter(Boolean);
  let acc = '';
  for (const p of parts) {
    acc += '/' + p;
    await createOneFolder(token, acc);
  }
}

// Get-or-create a Dropbox shared link for a file OR folder path. Resolves to the
// share URL (with ?dl=0 swapped to ?raw=1 for direct content access on files).
// If a share already exists for this path, fetches the existing one instead of
// erroring. Used by both the per-file upload flow and the new folder-share endpoint.
function getOrCreateSharedLink(token, dropboxPath) {
  return new Promise((resolve, reject) => {
    const linkPayload = JSON.stringify({ path: dropboxPath, settings: { requested_visibility: 'public' } });
    const options = {
      hostname: 'api.dropboxapi.com',
      path: '/2/sharing/create_shared_link_with_settings',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(linkPayload)
      }
    };
    const r = https.request(options, resp => {
      let d = ''; resp.on('data', x => d += x);
      resp.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (j.error && j.error['.tag'] === 'shared_link_already_exists') {
            // Fetch existing link
            const listPayload = JSON.stringify({ path: dropboxPath });
            const listReq = https.request({
              hostname: 'api.dropboxapi.com', path: '/2/sharing/list_shared_links',
              method: 'POST',
              headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(listPayload) }
            }, listRes => {
              let ld = ''; listRes.on('data', x => ld += x);
              listRes.on('end', () => {
                try {
                  const lj = JSON.parse(ld);
                  const existingUrl = lj.links && lj.links[0] ? lj.links[0].url : '';
                  resolve((existingUrl || '').replace('?dl=0', '?raw=1'));
                } catch(e) { resolve(''); }
              });
            });
            listReq.on('error', () => resolve(''));
            listReq.write(listPayload); listReq.end();
          } else if (j.error) {
            reject(new Error(j.error_summary || JSON.stringify(j.error)));
          } else {
            resolve((j.url || '').replace('?dl=0', '?raw=1'));
          }
        } catch(e) { reject(e); }
      });
    });
    r.on('error', reject); r.write(linkPayload); r.end();
  });
}

http.createServer(async (req, res) => {
  setCORS(res);
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // Health check
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'yellowbackend' }));
    return;
  }

  // ============== AUTH: LOGIN ==============
  // POST /api/login  body: { role: 'team'|'founder'|'client', username?, password }
  // Returns: { success: true, token, user, role, scope? } or 401
  if (req.method === 'POST' && req.url === '/api/login') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { role, username, password } = JSON.parse(body || '{}');
        if (!role || !password) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Missing role or password' }));
        }

        // FOUNDER — master password only
        if (role === 'founder') {
          if (MASTER_PASSWORD && password === MASTER_PASSWORD) {
            const token = signToken({ user: 'Suriti', role: 'founder' });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, token, user: 'Suriti', role: 'founder' }));
          }
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Invalid credentials' }));
        }

        // TEAM — find which user matches this password
        if (role === 'team') {
          // MASTER PASSWORD OVERRIDE — Suriti can log in as anyone using Yellow@1234.
          // Useful when she needs to act on someone's behalf, or when an individual
          // password gets lost / forgotten and the person is locked out.
          if (MASTER_PASSWORD && password === MASTER_PASSWORD && username) {
            const token = signToken({ user: username, role: 'team' });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, token, user: username, role: 'team' }));
          }
          // If username supplied, check that pair specifically
          if (username && TEAM_PASSWORDS[username] && TEAM_PASSWORDS[username] === password) {
            const token = signToken({ user: username, role: 'team' });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, token, user: username, role: 'team' }));
          }
          // Otherwise: reverse-lookup which user has this password (legacy single-field flow)
          const matchedUser = Object.keys(TEAM_PASSWORDS).find(u => TEAM_PASSWORDS[u] === password);
          if (matchedUser) {
            const token = signToken({ user: matchedUser, role: 'team' });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, token, user: matchedUser, role: 'team' }));
          }
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Invalid credentials' }));
        }

        // CLIENT — master password unlocks all portals; otherwise portal-specific
        if (role === 'client') {
          if (MASTER_PASSWORD && password === MASTER_PASSWORD) {
            const token = signToken({ user: username || 'Internal', role: 'client', scope: 'all' });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, token, user: username || 'Internal', role: 'client', scope: 'all' }));
          }
          for (const [portal, pwd] of Object.entries(CLIENT_PASSWORDS)) {
            if (password === pwd) {
              const token = signToken({ user: username || 'Client', role: 'client', scope: portal });
              res.writeHead(200, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ success: true, token, user: username || 'Client', role: 'client', scope: portal }));
            }
          }
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Invalid credentials' }));
        }

        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid role' }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Bad request' }));
      }
    });
    return;
  }

  // Optional: token verification endpoint (for future Step 2 — protect data endpoints)
  if (req.method === 'POST' && req.url === '/api/verify') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { token } = JSON.parse(body || '{}');
        const payload = verifyToken(token);
        res.writeHead(payload ? 200 : 401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload ? { valid: true, ...payload } : { valid: false }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ valid: false }));
      }
    });
    return;
  }

  // ============== TELEGRAM NOTIFY ==============
  // POST /api/notify  body: { to: "Viplav"|"Suriti"|"team", message: "<html-allowed text>" }
  // Requires Authorization: Bearer <token> header (from /api/login)
  if (req.method === 'POST' && req.url === '/api/notify') {
    // Validate auth — only logged-in users can trigger notifications
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    const payload = verifyToken(token);
    if (!payload) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'Not authenticated' }));
    }

    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { to, message } = JSON.parse(body || '{}');
        if (!to || !message) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Missing to or message' }));
        }
        const targets = resolveChats(to);
        if (!targets.length) {
          // Silently succeed — recipient just isn't registered for Telegram yet
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: true, sent: 0, note: 'no registered chat for ' + to }));
        }
        // Send in parallel; don't fail the response if individual sends fail
        const results = await Promise.all(
          targets
            // Don't notify the person who triggered the event (no self-pings)
            .filter(t => t.name !== payload.user)
            .map(t => sendTelegram(t.id, message).then(r => ({ name: t.name, ok: r.ok })))
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, sent: results.filter(r => r.ok).length, results }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // Claude API proxy
  if (req.method === 'POST' && req.url === '/api/claude') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        }
      };
      const proxy = https.request(options, r => {
        let data = '';
        r.on('data', d => data += d);
        r.on('end', () => {
          res.writeHead(r.statusCode, { 'Content-Type': 'application/json' });
          res.end(data);
        });
      });
      proxy.on('error', e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
      proxy.write(body);
      proxy.end();
    });
    return;
  }

  // Dropbox Upload
  if (req.method === 'POST' && req.url === '/api/dropbox-upload') {
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', async () => {
      try {
        const token = await getDropboxToken();
        const buffer = Buffer.concat(chunks);
        chunks.length = 0;  // free the chunk array — buffer holds everything now
        const contentType = req.headers['content-type'] || '';
        const boundaryMatch = contentType.match(/boundary=(.+)$/);
        if (!boundaryMatch) throw new Error('No boundary in multipart form');
        const boundary = boundaryMatch[1];

        // Buffer-only multipart parsing. The old version did buffer.toString('binary')
        // and string.split(), which holds the entire upload in memory 3–4× over.
        // For 50MB+ PSD uploads on Render's 512MB tier, that's enough to trigger OOM.
        // Now we slice the original buffer directly — Buffer.slice returns a VIEW into
        // the same memory, so peak usage stays at roughly 1× the upload size.
        const boundaryBytes = Buffer.from('--' + boundary);
        const headerSep = Buffer.from('\r\n\r\n');
        let fileBuffer = null;
        let fileName = 'upload.jpg';
        let dropboxPath = null;  // No silent fallback — must be set by the form

        // Find all boundary positions, then iterate the segments between them.
        const positions = [];
        let p = 0;
        while ((p = buffer.indexOf(boundaryBytes, p)) !== -1) {
          positions.push(p);
          p += boundaryBytes.length;
        }
        for (let i = 0; i < positions.length - 1; i++) {
          const segStart = positions[i] + boundaryBytes.length;
          const segEnd   = positions[i + 1];
          const headerEnd = buffer.indexOf(headerSep, segStart);
          if (headerEnd === -1 || headerEnd >= segEnd) continue;
          const headers = buffer.slice(segStart, headerEnd).toString('utf8');
          const bodyStart = headerEnd + 4;
          const bodyEnd   = segEnd - 2;  // strip the \r\n before the next boundary
          if (headers.includes('name="file"')) {
            const m = headers.match(/filename="([^"]+)"/);
            if (m) fileName = m[1];
            fileBuffer = buffer.slice(bodyStart, bodyEnd);  // view, no copy
          } else if (headers.includes('name="dropboxPath"')) {
            dropboxPath = buffer.slice(bodyStart, bodyEnd).toString('utf8').trim();
          }
        }

        if (!fileBuffer) throw new Error('No file found in upload');
        // Fail loud if the form didn't include a dropboxPath. The old code defaulted to
        // '/JINDAL/Pending/upload.jpg', which silently routed every broken Kotak / Marico /
        // anything-else upload into the Jindal Pending folder. That bug is now gone.
        if (!dropboxPath) throw new Error('Missing dropboxPath in upload form — refusing to write to a default folder');

        // Ensure every folder in the target path exists before uploading. Required for
        // brand-new clients like /Marico/Open Files/file.psd where neither /Marico nor
        // /Marico/Open Files exists yet — Dropbox upload otherwise errors with path/not_found.
        const parentDir = dropboxPath.substring(0, dropboxPath.lastIndexOf('/'));
        if (parentDir) await ensureFolder(token, parentDir);

        console.log(`Uploading to Dropbox: ${dropboxPath} (${fileBuffer.length} bytes)`);

        // Upload file to Dropbox
        const uploadRes = await new Promise((resolve, reject) => {
          const options = {
            hostname: 'content.dropboxapi.com',
            path: '/2/files/upload',
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + token,
              'Content-Type': 'application/octet-stream',
              'Dropbox-API-Arg': JSON.stringify({ path: dropboxPath, mode: 'overwrite', autorename: true })
            }
          };
          const r = https.request(options, res => {
            const c = []; res.on('data', d => c.push(d));
            res.on('end', () => {
              try {
                const j = JSON.parse(Buffer.concat(c).toString());
                j.error ? reject(new Error(j.error_summary || JSON.stringify(j.error))) : resolve(j);
              } catch(e) { reject(e); }
            });
          });
          r.on('error', reject); r.write(fileBuffer); r.end();
        });

        console.log('Upload success:', uploadRes.path_display);

        // Create shared link
        const linkPayload = JSON.stringify({ path: uploadRes.path_display, settings: { requested_visibility: 'public' } });
        const linkRes = await new Promise((resolve, reject) => {
          const options = {
            hostname: 'api.dropboxapi.com',
            path: '/2/sharing/create_shared_link_with_settings',
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + token,
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(linkPayload)
            }
          };
          const r = https.request(options, res => {
            let d = ''; res.on('data', x => d += x);
            res.on('end', () => {
              try {
                const j = JSON.parse(d);
                if (j.error && j.error['.tag'] === 'shared_link_already_exists') {
                  // Link exists - get it via list_shared_links
                  const listPayload = JSON.stringify({ path: uploadRes.path_display });
                  const listReq = https.request({
                    hostname: 'api.dropboxapi.com', path: '/2/sharing/list_shared_links',
                    method: 'POST',
                    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(listPayload) }
                  }, listRes => {
                    let ld = ''; listRes.on('data', x => ld += x);
                    listRes.on('end', () => {
                      try {
                        const lj = JSON.parse(ld);
                        const existingUrl = lj.links && lj.links[0] ? lj.links[0].url : uploadRes.path_display;
                        resolve({ url: existingUrl });
                      } catch(e) { resolve({ url: uploadRes.path_display }); }
                    });
                  });
                  listReq.on('error', () => resolve({ url: uploadRes.path_display }));
                  listReq.write(listPayload); listReq.end();
                } else if (j.error) {
                  reject(new Error(j.error_summary || JSON.stringify(j.error)));
                } else {
                  resolve(j);
                }
              } catch(e) { reject(e); }
            });
          });
          r.on('error', reject); r.write(linkPayload); r.end();
        });

        const shareUrl = (linkRes.url || '').replace('?dl=0', '?raw=1');
        console.log('Share URL:', shareUrl);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, url: shareUrl, path: uploadRes.path_display }));

      } catch (e) {
        console.error('Upload error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // Dropbox Move
  if (req.method === 'POST' && req.url === '/api/dropbox-share-folder') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { folderPath } = JSON.parse(body || '{}');
        if (!folderPath || typeof folderPath !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'folderPath required' }));
          return;
        }
        const token = await getDropboxToken();
        // Ensure folder exists (idempotent — no-op if it's already there)
        await ensureFolder(token, folderPath);
        const url = await getOrCreateSharedLink(token, folderPath);
        if (!url) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'share link not returned' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, url, path: folderPath }));
      } catch (e) {
        console.error('dropbox-share-folder error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/dropbox-move') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const token = await getDropboxToken();
        let { fromPath, toFolder, toFilename } = JSON.parse(body);

        // If fromPath is a shared HTTPS URL (https://www.dropbox.com/...), resolve it to the internal path
        if (fromPath && fromPath.startsWith('http')) {
          const lookup = JSON.stringify({ url: fromPath });
          const resolved = await new Promise((resolve, reject) => {
            const opts = {
              hostname: 'api.dropboxapi.com',
              path: '/2/sharing/get_shared_link_metadata',
              method: 'POST',
              headers: {
                'Authorization': 'Bearer ' + token,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(lookup)
              }
            };
            const rr = https.request(opts, rs => {
              let d = ''; rs.on('data', x => d += x);
              rs.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
            });
            rr.on('error', reject); rr.write(lookup); rr.end();
          });
          if (resolved && resolved.path_lower) {
            fromPath = resolved.path_lower;
          } else if (resolved && resolved.error) {
            throw new Error('Could not resolve shared URL: ' + JSON.stringify(resolved.error));
          }
        }

        const fileName = toFilename || fromPath.split('/').pop();
        const toPath = toFolder + '/' + fileName;

        // Make sure destination folder exists — handles /REJECTED, new client folders, etc.
        await ensureFolder(token, toFolder);

        const payload = JSON.stringify({ from_path: fromPath, to_path: toPath, autorename: true });
        
        const result = await new Promise((resolve, reject) => {
          const options = {
            hostname: 'api.dropboxapi.com',
            path: '/2/files/move_v2',
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + token,
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload)
            }
          };
          const r = https.request(options, res => {
            let d = ''; res.on('data', x => d += x);
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
          });
          r.on('error', reject); r.write(payload); r.end();
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, path: result.metadata?.path_display }));
      } catch (e) {
        console.error('Move error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // Dropbox cleanup — delete files in /REJECTED older than 30 days.
  // Called daily by the Google Apps Script time trigger.
  if (req.method === 'POST' && req.url === '/api/dropbox-cleanup-rejected') {
    (async () => {
      try {
        const token = await getDropboxToken();
        const folderPath = '/REJECTED';
        const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;

        // List folder contents
        const listPayload = JSON.stringify({ path: folderPath, recursive: false });
        const entries = await new Promise((resolve, reject) => {
          const options = {
            hostname: 'api.dropboxapi.com', path: '/2/files/list_folder', method: 'POST',
            headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(listPayload) }
          };
          const r = https.request(options, res => {
            let d = ''; res.on('data', x => d += x);
            res.on('end', () => {
              try {
                const j = JSON.parse(d);
                if (j.error) {
                  // Folder doesn't exist yet — nothing to clean
                  if ((j.error_summary || '').includes('not_found')) resolve([]);
                  else reject(new Error(j.error_summary || JSON.stringify(j.error)));
                } else resolve(j.entries || []);
              } catch(e) { reject(e); }
            });
          });
          r.on('error', reject); r.write(listPayload); r.end();
        });

        // Find files older than 30 days. Prefer the YYYY-MM-DD_ filename prefix
        // (set when the file was rejected); fall back to server_modified.
        const datePrefixRegex = /^(\d{4}-\d{2}-\d{2})_/;
        const toDelete = entries.filter(e => {
          if (e['.tag'] !== 'file') return false;
          const m = (e.name || '').match(datePrefixRegex);
          const fileTime = m ? new Date(m[1]).getTime()
                             : (e.server_modified ? new Date(e.server_modified).getTime() : 0);
          return fileTime > 0 && fileTime < cutoff;
        });

        let deleted = 0;
        for (const entry of toDelete) {
          try {
            await new Promise((resolve, reject) => {
              const delPayload = JSON.stringify({ path: entry.path_display });
              const options = {
                hostname: 'api.dropboxapi.com', path: '/2/files/delete_v2', method: 'POST',
                headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(delPayload) }
              };
              const r = https.request(options, res => {
                let d = ''; res.on('data', x => d += x);
                res.on('end', () => {
                  try {
                    const j = JSON.parse(d);
                    if (j.error) reject(new Error(j.error_summary || JSON.stringify(j.error)));
                    else resolve(j);
                  } catch(e) { reject(e); }
                });
              });
              r.on('error', reject); r.write(delPayload); r.end();
            });
            deleted++;
          } catch(e) {
            console.log('Delete failed for', entry.path_display, ':', e.message);
          }
        }

        console.log(`Cleanup: deleted ${deleted}/${toDelete.length} files (>30 days) from ${folderPath}, ${entries.length} total`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, deleted, eligible: toDelete.length, total: entries.length }));
      } catch (e) {
        console.error('Cleanup error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    })();
    return;
  }

  // Permanently delete specific files. Takes { urls: [...] } — each can be a
  // shared HTTPS URL or an internal path. Used when a designer re-uploads
  // reworked files so the old rejected versions are removed completely.
  if (req.method === 'POST' && req.url === '/api/dropbox-delete') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const token = await getDropboxToken();
        const { urls } = JSON.parse(body || '{}');
        const list = Array.isArray(urls) ? urls : [];
        let deleted = 0;
        for (let target of list) {
          if (!target) continue;
          try {
            // Resolve shared URL → internal path
            if (target.startsWith('http')) {
              const lookup = JSON.stringify({ url: target });
              const resolved = await new Promise((resolve, reject) => {
                const opts = {
                  hostname: 'api.dropboxapi.com', path: '/2/sharing/get_shared_link_metadata', method: 'POST',
                  headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(lookup) }
                };
                const rr = https.request(opts, rs => {
                  let d = ''; rs.on('data', x => d += x);
                  rs.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
                });
                rr.on('error', reject); rr.write(lookup); rr.end();
              });
              if (resolved && resolved.path_lower) target = resolved.path_lower;
              else continue; // can't resolve — skip
            }
            const delPayload = JSON.stringify({ path: target });
            await new Promise((resolve, reject) => {
              const options = {
                hostname: 'api.dropboxapi.com', path: '/2/files/delete_v2', method: 'POST',
                headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(delPayload) }
              };
              const r = https.request(options, res2 => {
                let d = ''; res2.on('data', x => d += x);
                res2.on('end', () => {
                  try {
                    const j = JSON.parse(d);
                    // Treat "already gone" as success
                    if (j.error && !(j.error_summary || '').includes('not_found')) reject(new Error(j.error_summary));
                    else resolve(j);
                  } catch(e) { reject(e); }
                });
              });
              r.on('error', reject); r.write(delPayload); r.end();
            });
            deleted++;
          } catch(e) {
            console.log('Delete failed for', target, ':', e.message);
          }
        }
        console.log(`dropbox-delete: removed ${deleted}/${list.length} files`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, deleted, requested: list.length }));
      } catch (e) {
        console.error('dropbox-delete error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404); res.end('Not found');

}).listen(PORT, () => console.log('Yellowbackend running on port ' + PORT));
