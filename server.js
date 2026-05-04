const https = require('https');
const http = require('http');
const PORT = process.env.PORT || 10000;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const DROPBOX_REFRESH_TOKEN = process.env.DROPBOX_REFRESH_TOKEN;
const DROPBOX_APP_KEY = process.env.DROPBOX_APP_KEY;
const DROPBOX_APP_SECRET = process.env.DROPBOX_APP_SECRET;

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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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
        const contentType = req.headers['content-type'] || '';
        const boundaryMatch = contentType.match(/boundary=(.+)$/);
        if (!boundaryMatch) throw new Error('No boundary in multipart form');
        const boundary = boundaryMatch[1];

        const bufStr = buffer.toString('binary');
        const parts = bufStr.split('--' + boundary);
        let fileBuffer = null;
        let fileName = 'upload.jpg';
        let dropboxPath = '/Yellowverse/Uploads/upload.jpg';

        for (const part of parts) {
          if (part.includes('name="file"')) {
            const match = part.match(/filename="([^"]+)"/);
            if (match) fileName = match[1];
            const bodyStart = part.indexOf('\r\n\r\n') + 4;
            const bodyEnd = part.lastIndexOf('\r\n');
            fileBuffer = Buffer.from(part.slice(bodyStart, bodyEnd), 'binary');
          }
          if (part.includes('name="dropboxPath"')) {
            const bodyStart = part.indexOf('\r\n\r\n') + 4;
            const bodyEnd = part.lastIndexOf('\r\n');
            dropboxPath = part.slice(bodyStart, bodyEnd).trim();
          }
        }

        if (!fileBuffer) throw new Error('No file found in upload');

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
  if (req.method === 'POST' && req.url === '/api/dropbox-move') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const token = await getDropboxToken();
        const { fromPath, toFolder } = JSON.parse(body);
        const fileName = fromPath.split('/').pop();
        const toPath = toFolder + '/' + fileName;
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

  res.writeHead(404); res.end('Not found');

}).listen(PORT, () => console.log('Yellowbackend running on port ' + PORT));
