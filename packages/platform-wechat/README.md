# @mtproto-relay/platform-wechat

Native CrossGram adapter for the legacy Windows **ComWeChat** HTTP and TCP-callback API.

```yaml
- id: wechat
  name: '@mtproto-relay/platform-wechat'
  disabled: true
  config:
    endpoint: http://127.0.0.1:18888/api/
    callbackHost: 127.0.0.1
    callbackPort: 23456
    requestTimeoutMs: 30000
    maxCallbackBytes: 1048576
    maxCallbackConnections: 32
```

## Security

ComWeChat is an old local-control API with **no authentication**. Do not expose its
HTTP endpoint to the public internet. The callback listener defaults to `127.0.0.1`,
limits payload size, and only acknowledges a callback after CrossGram has handled it.
For separate hosts, set `callbackHost` to CrossGram's specific LAN IP and
`callbackAllowedAddress` to the ComWeChat host's LAN IP. Wildcard binds are refused.
Restrict the callback port to that peer in the host firewall as well. The protocol
provides no callback token or MAC, so source IP filtering is the only built-in check.

ComWeChat's message hook takes only a callback **port** and connects to its own
localhost. On the Windows host, forward that local port to CrossGram's LAN listener
before enabling the adapter, for example from an elevated PowerShell prompt:

```powershell
netsh interface portproxy add v4tov4 listenaddress=127.0.0.1 listenport=23456 connectaddress=10.21.0.213 connectport=23456
```

Then configure CrossGram with `endpoint: http://10.21.0.51:8000/api/`,
`callbackHost: 10.21.0.213`, and `callbackAllowedAddress: 10.21.0.51`.
Replace these example addresses with the actual hosts. `portproxy` requires the
Windows IP Helper service and remains configured until removed.

## Capability boundary

The adapter supports login/account discovery, contacts as direct/group dialogs,
group-member listing, and real-time callback messages. It has no history or
read-state API. Sending, edits, deletes, forwarding, stickers, and media sending
are not supported.

ComWeChat callback attachment paths are deliberately not read. A callback could
otherwise make CrossGram read arbitrary local files. Images, files, voice messages,
videos, and animated stickers are therefore presented as text descriptions.
