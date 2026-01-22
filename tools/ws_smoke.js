import WebSocket from 'ws';

const urlArg = process.argv.find((a) => a.startsWith('--url='));
const WS_URL = urlArg ? urlArg.slice('--url='.length) : 'ws://localhost:7071';
const CLIENTS = 5;
const TIMEOUT_MS = 5000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runClient(idx) {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL);
    const result = {
      idx,
      welcome: false,
      error: null,
      closed: false,
      side: null,
      code: null,
      snapshot: false,
    };
    const timer = setTimeout(() => {
      result.error = result.error || 'TIMEOUT';
      ws.close();
      resolve(result);
    }, TIMEOUT_MS);

    ws.on('open', () => {
      const hello = {
        type: 'HELLO',
        payload: { userId: `smoke-${idx}`, username: `smoke_${idx}` },
      };
      ws.send(JSON.stringify(hello));
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'WELCOME') {
          result.welcome = true;
          result.side = msg.payload?.side;
        }
        if (msg.type === 'ERROR') {
          result.error = msg.payload?.code || 'ERROR';
          result.code = msg.payload?.code;
          ws.close();
          clearTimeout(timer);
          resolve(result);
        }
        if (msg.type === 'SNAPSHOT' && !result.welcome) {
          result.error = 'NO_WELCOME';
          ws.close();
          clearTimeout(timer);
          resolve(result);
        }
        if (msg.type === 'SNAPSHOT' && result.welcome) {
          result.snapshot = true;
          clearTimeout(timer);
          ws.close();
          resolve(result);
        }
      } catch (err) {
        result.error = 'BAD_JSON';
        ws.close();
        clearTimeout(timer);
        resolve(result);
      }
    });

    ws.on('close', () => {
      result.closed = true;
      clearTimeout(timer);
      resolve(result);
    });

    ws.on('error', (err) => {
      result.error = err?.code || 'WS_ERROR';
      clearTimeout(timer);
      resolve(result);
    });
  });
}

async function main() {
  const results = [];
  for (let i = 0; i < CLIENTS; i++) {
    const res = await runClient(i + 1);
    results.push(res);
    // small delay between connections
    await delay(50);
  }

  const welcomed = results.filter((r) => r.welcome);
  const roomFull = results.find((r) => r.code === 'ROOM_FULL');
  const failed = results.filter((r) => !r.welcome && !r.code);
  const missingSnapshots = results.filter((r) => r.welcome && !r.snapshot && !r.code);

  console.log('WS smoke summary:', { welcomed: welcomed.length, roomFull: !!roomFull, total: results.length });
  results.forEach((r) => {
    console.log(
      `client #${r.idx}: welcome=${r.welcome} side=${r.side || '-'} error=${r.error || '-'} code=${r.code || '-'}`
    );
  });

  if (welcomed.length === 4 && roomFull && failed.length === 0 && missingSnapshots.length === 0) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Smoke failed', err);
  process.exit(1);
});
