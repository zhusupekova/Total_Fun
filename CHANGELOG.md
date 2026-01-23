# Changelog

## Unreleased
- Auth: Telegram initData verification (`REQUIRE_AUTH`, `BOT_TOKEN`), rate limits (messages, IP, payload), optional debug gating.
- Network: config sync in snapshots (arena/physics/magnets/scoreToWin/roomTimeout), client interpolation buffer, input throttling, auto reconnect CTA, ping display.
- Gameplay: optional scoring (`SCORE_TO_WIN`), match reasons/banners, auto reset after FINISHED, clamp net player positions, optional room timeout.
- Assets: placeholder GLB (arena, ball, 4 characters, fallback).
- UI: safe-area, theme colors from Telegram, match/score HUD, error and retry banners, debug UI toggle.
- Tooling: static export, Playwright smoke, WS smoke, CI workflows, ESLint/Prettier, server:start helper.
