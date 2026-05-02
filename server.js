const https = require('https');

const PORT = process.env.PORT || 10000;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const DROPBOX_TOKEN = process.env.DROPBOX_TOKEN;

require('http').createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

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

  // Dropbox upload proxy
  if (req.method === 'POST' && req.url === '/api/dropbox-upload') {
    let chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', async () => {
      try {
        const boundary = req.headers['content-type'].split('boundary=')[1];
        const buffer = Buffer.concat(chunks);
        const bodyStr = buffer.toString('binary');

        // Extract filename and path from headers part
        const headerEnd = bodyStr.indexOf('\r\n\r\n');
        const headerPart = bodyStr.substring(0, headerEnd);
        const filenameMatch = headerPart.match(/filename="([^"]+)"/);
        const pathMatch = headerPart.match(/name="dropboxPath"\r\n\r\n([^\r\n]+)/);

        const filename = filenameMatch ? filenameMatch[1] : 'file';
        const dropboxPath = pathMatch ? pathMatch[1] : `/Jindal/Creatives/${filename}`;

        // Extract file binary data
        const dataStart = bodyStr.indexOf('\r\n\r\n', bodyStr.indexOf('Content-Type')) + 4;
        const dataEnd = bodyStr.lastIndexOf('\r\n--');
        const fileData = Buffer.from(bodyStr.substring(dataStart, dataEnd), 'binary');

        // Upload to Dropbox
        const uploadArg = JSON.stringify({ path: dropboxPath, mode: 'add', autorename: true });

        const options = {
          hostname: 'content.dropboxapi.com',
          path: '/2/files/upload',
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${DROPBOX_TOKEN}`,
            'Content-Type': 'application/octet-stream',
            'Dropbox-API-Arg': uploadArg,
            'Content-Length': fileData.length
          }
        };

        const upload = https.request(options, r => {
          let data = '';
          r.on('data', d => data += d);
          r.on('end', () => {
            const result = JSON.parse(data);
            // Get shared link
            const linkOptions = {
              hostname: 'api.dropboxapi.com',
              path: '/2/sharing/create_shared_link_with_settings',
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${DROPBOX_TOKEN}`,
                'Content-Type': 'application/json'
              }
            };
            const linkData = JSON.stringify({ path: result.path_display, settings: { requested_visibility: 'public' } });
            const linkReq = https.request(linkOptions, lr => {
              let ld = '';
              lr.on('data', d => ld += d);
              lr.on('end', () => {
                const linkResult = JSON.parse(ld);
                const shareUrl = linkResult.url || linkResult.error?.shared_link_already_exists?.metadata?.url;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, path: result.path_display, url: shareUrl }));
              });
            });
            linkReq.write(linkData);
            linkReq.end();
          });
        });

        upload.on('error', e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
        upload.write(fileData);
        upload.end();

      } catch(e) {
        res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Dropbox move file (on approval)
  if (req.method === 'POST' && req.url === '/api/dropbox-move') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { fromPath, toFolder } = JSON.parse(body);
        if (!fromPath) {
          res.writeHead(400); res.end(JSON.stringify({ error: 'fromPath required' })); return;
        }

        // Build destination path — keep filename, move to Approved folder
        const filename = fromPath.split('/').pop();
        const destination = toFolder
          ? `${toFolder}/${filename}`
          : `/Jindal/Creatives/Approved/${filename}`;

        const moveData = JSON.stringify({
          from_path: fromPath,
          to_path: destination,
          autorename: true
        });

        const options = {
          hostname: 'api.dropboxapi.com',
          path: '/2/files/move_v2',
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${DROPBOX_TOKEN}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(moveData)
          }
        };

        const moveReq = https.request(options, r => {
          let data = '';
          r.on('data', d => data += d);
          r.on('end', () => {
            const result = JSON.parse(data);
            if (result.metadata) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true, path: result.metadata.path_display }));
            } else {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, error: result }));
            }
          });
        });

        moveReq.on('error', e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
        moveReq.write(moveData);
        moveReq.end();

      } catch(e) {
        res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404); res.end('Not found');

}).listen(PORT, () => console.log(`Yellow Productions backend running on port ${PORT}`));
