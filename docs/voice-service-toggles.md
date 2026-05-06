# Voice Service GPU Toggles

Three env-var flags let you individually disable any GPU-backed voice service
without editing `TTS_PROVIDER` or rewriting systemd units.

## The Flags

| Env Var | Default | Controls |
|---|---|---|
| `JARVIS_STT_ENABLED` | `true` | Faster-Whisper STT (large-v3-turbo, ~3-4 GB VRAM, port 8766) |
| `JARVIS_TTS_CHATTERBOX_ENABLED` | `true` | Chatterbox TTS voice clone (~4-6 GB VRAM, port 3340) |
| `JARVIS_TTS_KOKORO_ENABLED` | `true` | Kokoro TTS docker container (~1-2 GB VRAM, port 8880) |

All three default to `true` — existing behaviour is 100% unchanged unless you
explicitly set one to `false`.

## Behaviour when disabled

**`JARVIS_STT_ENABLED=false`**
- `transcribeAudio()` immediately returns `{ text: '', rejected: 'stt_disabled' }`.
- No connection is made to the Faster-Whisper service; no CUDA context is opened.
- Voice input effectively stops working. The bot is still online and responds to
  text commands / Discord messages. Health status reports `disabled`.
- `checkSttHealth()` (called at startup) logs a notice and returns early — no error.

**`JARVIS_TTS_CHATTERBOX_ENABLED=false`**
- `synthesizeSpeech()` and `synthesizeChatterboxStream()` skip Chatterbox and fall
  back to Edge TTS (CPU, cloud, free).
- `switchChatterboxVoice()` is a no-op — no pre-warm HTTP call is made.
- The GPU warmup synthesis on startup is skipped.
- Health status reports `chatterbox-<voice> DISABLED`.

**`JARVIS_TTS_KOKORO_ENABLED=false`**
- `synthesizeSpeech()` and `synthesizeKokoroStream()` skip Kokoro and fall back to
  Edge TTS (CPU, cloud, free).
- Health status reports `kokoro-<voice> DISABLED`.

Note: `piper` and `edge` are CPU-only and do not have dedicated toggle flags.
They are always available as fallbacks.

## Example `.env` snippets

### All on (default — no change from before)
```
JARVIS_STT_ENABLED=true
JARVIS_TTS_CHATTERBOX_ENABLED=true
JARVIS_TTS_KOKORO_ENABLED=true
```

### STT only off (free the Whisper VRAM, keep TTS)
```
JARVIS_STT_ENABLED=false
# JARVIS_TTS_CHATTERBOX_ENABLED and JARVIS_TTS_KOKORO_ENABLED not needed — default true
```

### TTS GPU off, keep STT (fall back to Edge TTS for voice output)
```
JARVIS_STT_ENABLED=true
JARVIS_TTS_CHATTERBOX_ENABLED=false
JARVIS_TTS_KOKORO_ENABLED=false
```

### All GPU voice services off — text-only mode
```
JARVIS_STT_ENABLED=false
JARVIS_TTS_CHATTERBOX_ENABLED=false
JARVIS_TTS_KOKORO_ENABLED=false
```
(The bot will still speak via Edge TTS (CPU, free) and listen for slash commands
 via Discord text, but won't process Discord voice input.)

## How to deploy

1. Edit `/home/generic/dev/jarvis-voice/.env` and add/change the desired flag(s).
2. Restart the orchestrator:
   ```
   systemctl --user restart jarvis-voice.service
   ```
3. Verify the health state — within 30 s the health monitor will log the new state.
   You can also query the admin API if `JARVIS_ADMIN_TOKEN` is set:
   ```
   curl -s -H "Authorization: Bearer $JARVIS_ADMIN_TOKEN" \
        http://127.0.0.1:3101/health | jq '.sttHealth, .ttsHealth'
   ```

## What is NOT changed

- `whisper-service.service` (the system-level Flask server on port 8766) is a
  separate systemd unit. `JARVIS_STT_ENABLED=false` stops the jarvis-voice bot
  from calling it but does not stop the service itself. Use
  `sudo systemctl stop whisper-service` to free the VRAM at the OS level.
- `jarvis-chatterbox-tts.service` and the Kokoro docker container are likewise
  separate. The toggle only prevents the orchestrator from calling them; the
  services themselves keep running. Stop them manually to reclaim VRAM.
- `jarvis-whisper-stt.service` (user-level duplicate) was disabled by Lance on
  2026-05-06 and is not affected.
