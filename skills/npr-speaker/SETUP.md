# npr-speaker Setup

## Requirements

- Sonos speaker(s) on the LAN
- `curl` (standard on most systems)
- No extra dependencies — streams directly via UPnP SOAP

## Configuration

Add to your Jarvis `.env`:

```env
SONOS_UP_IP=x.x.x.x        # Upstairs Sonos IP (e.g. bedroom)
SONOS_DOWN_IP=x.x.x.x      # Downstairs Sonos IP (e.g. kitchen)
SONOS_DEFAULT=down          # Default speaker target
NPR_STREAM=https://npr-ice.streamguys1.com/live.mp3  # NPR live stream URL
```

`NPR_STREAM` defaults to the national NPR News Now stream if unset. Replace with your local station's stream URL if preferred.

## Install sonos-npr script

Save to `~/.local/bin/sonos-npr` and `chmod +x`:

```bash
#!/bin/bash
# sonos-npr — play or stop NPR live radio on a Sonos speaker via UPnP
# Usage: sonos-npr [up|down|all]            — play NPR on target speaker
#        sonos-npr stop [up|down|all]        — stop playback

ACTION="${1:-${SONOS_DEFAULT:-down}}"
SPEAKER="${2:-${SONOS_DEFAULT:-down}}"

SONOS_UP="${SONOS_UP_IP:-}"
SONOS_DOWN="${SONOS_DOWN_IP:-}"
NPR_STREAM="${NPR_STREAM:-https://npr-ice.streamguys1.com/live.mp3}"

soap_post() {
  local IP="$1" ACTION_NAME="$2" BODY="$3"
  curl -s "http://${IP}:1400/MediaRenderer/AVTransport/Control" \
    -H 'Content-Type: text/xml' \
    -H "SOAPAction: \"urn:schemas-upnp-org:service:AVTransport:1#${ACTION_NAME}\"" \
    -d "<?xml version=\"1.0\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" \
s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body>${BODY}</s:Body></s:Envelope>" \
    > /dev/null
}

stop_speaker() {
  local IP="$1"
  soap_post "$IP" "Stop" \
    "<u:Stop xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\"><InstanceID>0</InstanceID></u:Stop>"
}

play_npr() {
  local IP="$1"
  # Stop + clear queue so no prior radio or queue resumes after stream ends
  stop_speaker "$IP"
  soap_post "$IP" "RemoveAllTracksFromQueue" \
    "<u:RemoveAllTracksFromQueue xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\"><InstanceID>0</InstanceID></u:RemoveAllTracksFromQueue>"
  soap_post "$IP" "SetAVTransportURI" \
    "<u:SetAVTransportURI xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\"><InstanceID>0</InstanceID><CurrentURI>${NPR_STREAM}</CurrentURI><CurrentURIMetaData></CurrentURIMetaData></u:SetAVTransportURI>"
  soap_post "$IP" "Play" \
    "<u:Play xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\"><InstanceID>0</InstanceID><Speed>1</Speed></u:Play>"
}

get_ips() {
  case "$1" in
    up)   echo "$SONOS_UP" ;;
    down) echo "$SONOS_DOWN" ;;
    all)  echo "$SONOS_UP $SONOS_DOWN" ;;
    *)    echo "$SONOS_DOWN" ;;
  esac
}

if [ "$ACTION" = "stop" ]; then
  for IP in $(get_ips "$SPEAKER"); do
    [ -n "$IP" ] && stop_speaker "$IP"
  done
  echo "NPR stopped on ${SPEAKER}"
else
  # ACTION holds the speaker target when playing
  for IP in $(get_ips "$ACTION"); do
    [ -n "$IP" ] && play_npr "$IP"
  done
  echo "NPR playing on ${ACTION}"
fi
```

## Finding Sonos IPs

```bash
nmap -sn 192.168.1.0/24 | grep -i sonos -A1
# or query directly:
curl -s http://CANDIDATE_IP:1400/xml/device_description.xml | grep roomName
```

## Common NPR Stream URLs

| Station | URL |
|---------|-----|
| NPR News Now (national) | `https://npr-ice.streamguys1.com/live.mp3` |
| WNYC (NY) | `https://fm939.wnyc.org/wnycfm.aac` |
| KQED (SF) | `https://streams.kqed.org/kqedradio` |
| WBUR (Boston) | `https://streams.wbur.org/wbur/main.mp3` |

Set `NPR_STREAM` in `.env` to your preferred station.

## Testing

```bash
sonos-npr down           # play on kitchen speaker
sonos-npr up             # play on bedroom speaker
sonos-npr all            # play everywhere
sonos-npr stop down      # stop kitchen speaker
```
