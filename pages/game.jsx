import Head from 'next/head';
import Script from 'next/script';
import dynamic from 'next/dynamic';
import { useEffect } from 'react';

function GameView() {
  useEffect(() => {
    import('../src/main.js');
  }, []);

  return (
    <>
      <Head>
        <title>Total_Fun — Stage 1</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      </Head>
      <Script src="https://telegram.org/js/telegram-web-app.js" strategy="afterInteractive" />
      <div id="app" />
      <div id="hud">
        <div className="row"><b>Controls:</b> Player 1 — <code>W/S</code> (forward/back), <code>A/D</code> (strafe)</div>
        <div className="row">Toggle pause — <code>Space</code>, Reset ball — <code>R</code></div>
        <div className="row">Bots: three AI paddles move and reflect the ball</div>
        <div className="row">Stage 1: arena + custom light physics (optional WS)</div>
        <div className="row" id="net-status" />
        <div className="row" id="match-status" />
        <button id="audio-toggle">Sound: on</button>
      </div>
      <div id="net-panel">
        <div>WebSocket server</div>
        <input id="ws-url" type="text" defaultValue="ws://localhost:7071" />
        <div style={{ display: 'flex', gap: '6px' }}>
          <button id="btn-connect">Connect</button>
          <button id="btn-disconnect" className="secondary">Disconnect</button>
        </div>
        <div id="players-list" />
      </div>
      <div id="touch-controls">
        <div className="tc-empty" />
        <div className="tc-btn" data-dir="up">▲</div>
        <div className="tc-empty" />
        <div className="tc-btn" data-dir="left">◀</div>
        <div className="tc-btn" data-dir="down">▼</div>
        <div className="tc-btn" data-dir="right">▶</div>
        <div className="tc-empty" />
      </div>
    </>
  );
}

export default dynamic(() => Promise.resolve(GameView), { ssr: false });
