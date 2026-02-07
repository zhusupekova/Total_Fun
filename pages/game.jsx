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
        <div className="row state-row">
          <span id="state-chip" className="pill">Idle</span>
        </div>
        <div className="row" id="net-status" />
        <div className="row" id="match-status" />
        <div className="row" id="player-board" />
      </div>
      <div id="error-banner" />
      <div id="match-banner" />
      <div id="cta-retry" className="cta-retry">Connection lost. Tap Retry.</div>
      <div id="net-panel" />
      <div id="investor-overlay">
        <div id="investor-overlay__text">Loading…</div>
        <div id="investor-overlay__subtext"></div>
      </div>
      <div id="finish-overlay">
        <div className="finish-title">Match Finished</div>
        <div className="finish-sub">Next match starting...</div>
      </div>
      <div id="invite-overlay">
        <div className="invite-text">Play with friends in Telegram</div>
        <button id="invite-btn" className="invite-btn">Invite Friend</button>
      </div>
      <div id="touch-controls">
        <div className="stick-base" />
        <div className="stick-thumb" id="stick-thumb" />
      </div>
      <div id="control-hint">Drag to move</div>
    </>
  );
}

export default dynamic(() => Promise.resolve(GameView), { ssr: false });
