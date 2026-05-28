# Director — TODOs

Items deferred from the design review (see `docs/ux-design.md` for full context).

## Phase 2 (post-hackathon, community-facing)

### a11y-1 — Live captions / transcript
- **What**: Visible mirror of Director's narration as a fading caption strip below the Strip, plus a Preferences toggle.
- **Why**: Critical for deaf/HoH users and anyone in noisy environments (meetings, coffee shops). Voice-only is not accessible.
- **Pros**: Removes a real exclusion gap. Also helps presentation contexts (you can show what the AI said when speakers are off).
- **Cons**: New surface to design; needs synchronization with Realtime audio_transcript.delta stream.
- **Depends on**: Realtime transcript stream wired through to UI state.

### onb-2 — Conversational onboarding evolution
- **What**: Replace minimal-seed onboarding (3A-1) with conversational welcome (3A-4 style). "Hi. Want a tour or are we starting?"
- **Why**: Hackathon ships minimal; community use needs slightly more guidance without lengthening the experience.
- **Pros**: Lower first-launch confusion for non-technical users.
- **Cons**: More code, more design polish. Risk of slipping into walkthrough cliche.

### theme-1 — Light mode
- **What**: Light mode variant. Vibrancy material switches to `.popover` light, palette inverts.
- **Why**: Some users prefer light. Director should match system preference.
- **Pros**: Polish, parity with system.
- **Cons**: Doubles theming work; vibrancy looks worse against bright wallpapers.

### type-1 — Söhne family swap
- **What**: License Söhne, replace Inter / JetBrains Mono.
- **Why**: True OpenAI-adjacent identity. Inter is a strong free analog but not the real thing.
- **Pros**: More distinctive typographic voice.
- **Cons**: License cost ($$$$).

### platform-1 — Windows / Linux ports
- **What**: Port Electron app to Windows + Linux with platform-appropriate window chrome.
- **Why**: Community demand likely.
- **Pros**: Wider reach.
- **Cons**: Loses macOS vibrancy magic; needs platform-specific window managers.

## Phase 3 (advanced features)

### voice-1 — Always-listening with wake word
- **What**: Replace PTT primary mode with continuous local wake-word detection ("Director, …").
- **Why**: Most immersive; matches voice-assistant grammar.
- **Pros**: Hands-free, no keyboard required.
- **Cons**: Requires local model (Picovoice, snowboy, etc.) or continuous Realtime (cost). Privacy implications.

### multi-1 — Pair / observer mode
- **What**: Mirror Canvas to a second screen / browser for pair driving.
- **Why**: Collaborative workflows.
- **Pros**: Demo-friendly, teaching-friendly.
- **Cons**: Routing complexity (whose voice commands route to the orchestrator?).

### pencil-1 — Pencil-driven theme overrides
- **What**: Designs from Pencil flow into Director's token system as live overrides.
- **Why**: Designers shouldn't need engineering for token changes.
- **Pros**: Tightens design loop.
- **Cons**: Schema bridging work.

## Engineering polish (when time permits)

### eng-1 — Tray icon design
- Hand-design a monochrome tray glyph (currently placeholder); both light and dark menu bar variants.

### eng-2 — Preferences window
- Real Preferences UI (currently stubbed). Hotkey rebind, voice selection (marin/cedar), session log access, DND override, mic device selection.

### eng-3 — Session log archive in tray
- Tray menu → "Recent sessions" → resume any past session, not just last.

### eng-4 — Crash recovery
- On app crash mid-session, next launch detects orphaned worktrees + transcript, offers recovery.

### eng-5 — Update mechanism
- Auto-update via electron-updater. Critical for community distribution.

### eng-6 — Telemetry opt-in
- Anonymous usage metrics to learn what works (with explicit opt-in).
