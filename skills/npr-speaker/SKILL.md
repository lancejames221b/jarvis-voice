---
name: npr-speaker
description: Play or stop NPR live radio on a Sonos speaker. Use when the user wants to turn on/off NPR news or live radio on the house speakers. Streams NPR live directly to Sonos via UPnP — no TTS, no download.
tier: FRIDAY
triggers:
  - "turn on NPR"
  - "play NPR"
  - "NPR on the speaker"
  - "put on NPR"
  - "play the news on the speaker"
  - "start NPR"
  - "stop NPR"
  - "turn off NPR"
  - "NPR downstairs"
  - "NPR upstairs"
  - "play news radio"
  - "play live radio"
  - "NPR live"
  - "turn off the speaker"
  - "stop the speaker"
---

# npr-speaker — NPR Live Radio on Sonos

Stream NPR live radio directly to any Sonos speaker in the house via UPnP. Instant — no file download, no TTS generation.

## Examples

> "Turn on NPR downstairs."
> "Play NPR on the kitchen speaker."
> "Put NPR on everywhere."
> "Stop NPR."
> "Turn off the speaker."

## Speaker Targets

| User says | Target | arg |
|-----------|--------|-----|
| "kitchen", "downstairs" | Kitchen Sonos | `down` |
| "bedroom", "upstairs" | Bedroom Sonos | `up` |
| "everywhere", "all speakers", "whole house" | Both | `all` |
| *(no location)* | `$SONOS_DEFAULT` (default: `down`) | — |

## Playing NPR

```bash
sonos-npr <up|down|all>
```

## Stopping

```bash
sonos-npr stop [up|down|all]
```

If no location is given for stop, stops the default speaker.

## Response Style

Keep it short and spoken-friendly:

- Start: *"NPR is on [location] now."*
- Stop: *"Speaker off."*
- Already playing: *"NPR's already on — should I switch speakers?"*

## Script

```bash
sonos-npr [up|down|all|stop [up|down|all]]
```

See `SETUP.md` for installation.
