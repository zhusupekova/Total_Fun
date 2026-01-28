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
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
      </Head>
      <Script src="https://telegram.org/js/telegram-web-app.js" strategy="afterInteractive" />
      <div id="app" />
      <div id="hud">
        <div className="row"><b>Controls:</b> Player 1 — <code>W/S</code> (forward/back), <code>A/D</code> (strafe)</div>
        <div className="row">Toggle pause — <code>Space</code>, Reset ball — <code>R</code></div>
        <div className="row debug-only">Bots: three AI paddles move and reflect the ball</div>
        <div className="row debug-only">Stage 1: arena + custom light physics (optional WS)</div>
        <div className="row state-row">
          <span id="state-chip" className="pill">Idle</span>
        </div>
        <div className="row" id="net-status" />
        <div className="row" id="match-status" />
        <div className="row" id="score-line" />
        <div className="row hud-actions">
          <button id="btn-start">Start</button>
          <button id="btn-reset" className="secondary">Reset</button>
        </div>
        <button id="audio-toggle">Sound: on</button>
      </div>
      <div id="error-banner" />
      <div id="match-banner" />
      <div id="cta-retry" className="cta-retry">Connection lost. Tap Retry.</div>
      <div id="net-panel" className="debug-only">
        <div>WebSocket server</div>
        <input id="ws-url" type="text" defaultValue="ws://localhost:7071" />
        <div style={{ display: 'flex', gap: '6px' }}>
          <button id="btn-connect">Connect</button>
          <button id="btn-disconnect" className="secondary">Disconnect</button>
          <button id="btn-retry" className="secondary">Retry</button>
        </div>
        <div id="players-list" />
      </div>
      <div id="touch-controls">
        <div className="stick-base" />
        <div className="stick-thumb" id="stick-thumb" />
      </div>
    </>
  );
}

export default dynamic(() => Promise.resolve(GameView), { ssr: false });
