const https = require('https');
const http = require('http');

const PORT = process.env.PORT || 10000;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const DROPBOX_TOKEN = process.env.DROPBOX_TOKEN;

http.createServer(async (req, res) => {
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
        const buffer = Buffer.concat(chunks);
        const bodyStr = buffer.toString('binary');

        // Extract dropboxPath from form data
        const pathMatch = bodyStr.match(/name="dropboxPath"\r\n\r\n([^\r\n]+)/);
        const dropboxPath = pathMatch ? pathMatch[1] : '/Jindal/Creatives/upload';

        // Extract filename
        const filenameMatch = bodyStr.match(/filename="([^"]+)"/);
        const filename = filenameMatch ? filenameMatch[1] : 'file';

        // Extract file content type
        const contentTypeMatch = bodyStr.match(/Content-Type: ([^\r\n]+)/);
        
        // Extract binary file data
        const dataStart = bodyStr.indexOf('\r\n\r\n', bodyStr.indexOf('Content-Type:')) + 4;
        const dataEnd = bodyStr.lastIndexOf('\r\n--');
        const fileData = Buffer.from(bodyStr.substring(dataStart, dataEnd), 'binary');

        // Step 1 — Upload to Dropbox
        const uploadArg = JSON.stringify({
          path: dropboxPath,
          mode: 'add',
          autorename: true
        });

        const uploadOptions = {
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

        const uploadResult = await new Promise((resolve, reject) => {
          const uploadReq = https.request(uploadOptions, r => {
            let data = '';
            r.on('data', d => data += d);
            r.on('end', () => resolve(JSON.parse(data)));
          });
          uploadReq.on('error', reject);
          uploadReq.write(fileData);
          uploadReq.end();
        });

        if (uploadResult.error_summary) {
          throw new Error(uploadResult.error_summary);
        }

        // Step 2 — Create shared link
        const linkOptions = {
          hostname: 'api.dropboxapi.com',
          path: '/2/sharing/create_shared_link_with_settings',
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${DROPBOX_TOKEN}`,
            'Content-Type': 'application/json'
          }
        };

        const linkBody = JSON.stringify({
          path: uploadResult.path_display,
          settings: { requested_visibility: 'public' }
        });

        const linkResult = await new Promise((resolve, reject) => {
          const linkReq = https.request(linkOptions, r => {
            let data = '';
            r.on('data', d => data += d);
            r.on('end', () => resolve(JSON.parse(data)));
          });
          linkReq.on('error', reject);
          linkReq.write(linkBody);
          linkReq.end();
        });

        // Handle already shared link
        const shareUrl = linkResult.url ||
          linkResult.error?.shared_link_already_exists?.metadata?.url ||
          uploadResult.path_display;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          path: uploadResult.path_display,
          url: shareUrl
        }));

      } catch(e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(200);
  res.end('Yellow Productions backend running');

}).listen(PORT, () => console.log(`Yellow Productions backend running on port ${PORT}`));
