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


---

## Programmatic service control (VRAM actually freed)

Setting a toggle to `false` not only prevents jarvis-voice from *calling* the
service — it also **stops the underlying systemd unit or Docker container** at
startup so the GPU VRAM is reclaimed immediately.

### How it works

1. At startup, before the Discord client connects, `src/service-control.js`
   inspects all three `JARVIS_*_ENABLED` flags.
2. For each flag that is `false`, it stops the corresponding service:

| Flag | Stop command issued | Default unit/container |
|---|---|---|
| `JARVIS_STT_ENABLED=false` | `sudo systemctl stop <unit>` | `whisper-service.service` |
| `JARVIS_TTS_CHATTERBOX_ENABLED=false` | `systemctl --user stop <unit>` | `jarvis-chatterbox-tts.service` |
| `JARVIS_TTS_KOKORO_ENABLED=false` | `docker stop <container>` | `kokoro` |

3. If a service is already stopped, the command is skipped (logged as "already stopped").
4. All stop failures are **logged and swallowed** — jarvis-voice continues starting up.
5. When jarvis-voice shuts down, stopped services are **left stopped** (you enabled the
   toggle for a reason; they restart on their own when you re-enable the flag and restart
   jarvis-voice, assuming they are `systemd` enabled).

### Customising unit / container names

Add these vars to your `.env` to override defaults (useful for non-standard distro setups):

```env
# systemd SYSTEM unit name for Faster-Whisper
JARVIS_STT_SYSTEMD_UNIT=whisper-service.service

# systemd USER unit name for Chatterbox TTS
JARVIS_TTS_CHATTERBOX_SYSTEMD_UNIT=jarvis-chatterbox-tts.service

# Docker container name (or leave default and rely on port-8880 fallback)
JARVIS_TTS_KOKORO_DOCKER_NAME=kokoro
```

### Required sudoers rule for STT (system-level unit)

`whisper-service.service` is a **system** unit and requires `sudo`.  The generic
user already has `NOPASSWD:ALL` on this machine, so no change is needed here.

For other deployments, add a minimal rule (do **not** grant `ALL`):

```
# /etc/sudoers.d/jarvis-voice  (edit with: sudo visudo -f /etc/sudoers.d/jarvis-voice)
youruser ALL=(ALL) NOPASSWD: /bin/systemctl stop whisper-service.service, /bin/systemctl start whisper-service.service
```

Replace `youruser` and the unit name if you changed `JARVIS_STT_SYSTEMD_UNIT`.

If `sudo -n true` fails at startup, jarvis-voice logs a clear warning with the
exact sudoers line to add — it never crashes.

### Chatterbox (user unit) — no sudo needed

`jarvis-chatterbox-tts.service` is managed with `systemctl --user stop` — no
elevated privileges required.

### Kokoro (Docker) — docker group membership

The user running jarvis-voice must be in the `docker` group:

```bash
sudo usermod -aG docker $USER   # then re-login
```

If Docker is unreachable, jarvis-voice logs a warning and continues.

### Docker port-8880 fallback

If `JARVIS_TTS_KOKORO_DOCKER_NAME` doesn't match any running container name,
jarvis-voice falls back to `docker ps --filter publish=8880` and stops whatever
container is found listening on that port. This handles renamed containers
transparently.

### No auto-restart on re-enable

jarvis-voice will **never** auto-start a service it stopped. When you flip a
flag back to `true` and restart jarvis-voice, the underlying service must already
be running (via its own `systemctl enable` / `docker run --restart=unless-stopped`
configuration). This keeps jarvis-voice out of the service orchestration business.
