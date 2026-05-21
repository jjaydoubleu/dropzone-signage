const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname)));

// Current display state
let lastMessage = { type: 'idle' };

// Serve the display page dynamically (no JS needed on TV)
app.get('/dropzone-display.html', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(buildDisplay(lastMessage));
});

// Polling endpoint for TV
app.get('/state', (req, res) => {
  res.json(lastMessage);
});

// Proxy endpoint: controller sends image + prompt → Claude API → returns extracted data
app.post('/extract', async (req, res) => {
  try {
    const { imageBase64, mediaType } = req.body;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: imageBase64 }
            },
            {
              type: 'text',
              text: `You are reading a screenshot of an IBIS flight manifest. 
Extract ONLY customer names (they appear in BOLD with a booking number like #12345 or B#12345 next to them).
Do NOT include tandem masters, pilots, instructors, or any non-bold names.
Also extract the flight number shown at the top (e.g. "flight 3").

Respond ONLY with valid JSON in this exact format, no preamble, no markdown:
{"flight": "3", "customers": ["John Smith", "Rachel Yu", "Adam Lovelock"]}`
            }
          ]
        }]
      })
    });

    const data = await response.json();
    console.log('Claude response:', JSON.stringify(data));
    
    if (data.error) throw new Error(data.error.message || 'API error');
    
    const text = (data.content || []).map(i => i.text || '').join('');
    if (!text) throw new Error('No text in response');
    
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    res.json({ success: true, flight: parsed.flight || '', customers: parsed.customers || [] });
  } catch (err) {
    console.error('Extract error:', err);
    res.json({ success: false, error: err.message });
  }
});

// Push a message to all displays
app.post('/push', (req, res) => {
  lastMessage = req.body;
  io.emit('display', lastMessage);
  res.json({ ok: true });
});

io.on('connection', (socket) => {
  socket.emit('display', lastMessage);
  socket.on('push', (msg) => {
    lastMessage = msg;
    io.emit('display', msg);
  });
});

function buildDisplay(msg) {
  let content = '';
  const type = msg.type || 'idle';

  if (type === 'idle') {
    content = `
      <div class="idle-wrap">
        <div class="idle-title">NZONE SKYDIVE</div>
        <div class="idle-sub">Dropzone — Waiting Area</div>
      </div>`;

  } else if (type === 'standby') {
    const names = (msg.customers || []);
    const nameRows = names.map(n =>
      `<div class="name-row"><span class="name-bullet">&#9654;</span><span class="name-text">${n}</span></div>`
    ).join('');

    content = `
      <div class="flight-badge">FLIGHT ${msg.flight || '?'}</div>
      <div class="call-label">NOW CALLING</div>
      <div class="call-headline">Please standby &amp; check your name</div>
      <div class="names-block">${nameRows}</div>
      <div class="call-footer">If your name is listed, please wait for the ground crew.</div>`;

  } else if (type === 'suitup') {
    const names = (msg.customers || []);
    const nameRows = names.map(n =>
      `<div class="name-row"><span class="name-bullet">&#9654;</span><span class="name-text">${n}</span></div>`
    ).join('');

    content = `
      <div class="flight-badge suitup">FLIGHT ${msg.flight || '?'}</div>
      <div class="call-label" style="color:#3dd68c;">GET READY</div>
      <div class="call-headline">Please make your way to the hangar</div>
      <div class="names-block">${nameRows}</div>
      <div class="call-footer">Follow the ground crew to get suited up.</div>`;
  }

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="refresh" content="3">
<title>Dropzone Display</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    background: #080c14;
    color: #ffffff;
    font-family: Arial, Helvetica, sans-serif;
    width: 100%; height: 100%; overflow: hidden;
    background-image: linear-gradient(135deg, #080c14 0%, #0d1520 100%);
  }
  #screen {
    position: fixed; top:0; left:0; right:0; bottom:0;
    display: table; width:100%; height:100%; text-align:center;
  }
  #inner { display:table-cell; vertical-align:middle; padding:40px 100px; }

  .idle-wrap { }
  .idle-title {
    font-size: 72px; font-weight: bold;
    letter-spacing: 12px; color: rgba(255,255,255,0.12);
    text-transform: uppercase;
  }
  .idle-sub { font-size: 24px; color: rgba(255,255,255,0.08); letter-spacing: 4px; margin-top: 16px; }

  .flight-badge {
    display: inline-block;
    background: #e87c2a;
    color: #ffffff;
    font-size: 22px;
    font-weight: bold;
    letter-spacing: 6px;
    padding: 8px 32px;
    border-radius: 4px;
    margin-bottom: 20px;
    text-transform: uppercase;
  }
  .flight-badge.suitup { background: #3dd68c; color: #080c14; }

  .call-label {
    font-size: 16px;
    letter-spacing: 8px;
    text-transform: uppercase;
    color: #e87c2a;
    margin-bottom: 10px;
  }

  .call-headline {
    font-size: 52px;
    font-weight: bold;
    color: #ffffff;
    line-height: 1.15;
    margin-bottom: 28px;
  }

  .names-block {
    display: inline-block;
    text-align: left;
    margin: 0 auto 24px;
    border-left: 3px solid #e87c2a;
    padding-left: 24px;
  }

  .name-row {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 6px 0;
  }

  .name-bullet { color: #e87c2a; font-size: 14px; }
  .name-text { font-size: 34px; font-weight: bold; color: #ffffff; letter-spacing: 1px; }

  .call-footer {
    font-size: 20px;
    color: #6b7894;
    margin-top: 8px;
  }

  #brand {
    position: fixed; top:20px; left:30px;
    font-size: 14px; letter-spacing: 4px;
    text-transform: uppercase; color: #1e2a3a;
  }
  #clock {
    position: fixed; bottom:20px; right:30px;
    font-size: 24px; color: #1e2a3a;
  }
</style>
</head>
<body>
<div id="brand">NZONE DROPZONE</div>
<div id="clock" id="clock">--:--:--</div>
<div id="screen"><div id="inner">${content}</div></div>
<script>
function tick() {
  var n = new Date();
  var h = String(n.getHours()).padStart(2,'0');
  var m = String(n.getMinutes()).padStart(2,'0');
  var s = String(n.getSeconds()).padStart(2,'0');
  var el = document.getElementById('clock');
  if (el) el.innerHTML = h+':'+m+':'+s;
}
setInterval(tick, 1000); tick();
</script>
</body>
</html>`;
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ Dropzone Signage running`);
  console.log(`   Controller: http://localhost:${PORT}/dropzone-controller.html`);
  console.log(`   TV Display:  http://localhost:${PORT}/dropzone-display.html\n`);
});
