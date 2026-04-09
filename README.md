# dangbro / dangbro-autoroot

Browser-assisted root exploit chain for LG webOS TVs.

**[Use it → azoffshowy.github.io/dangbro](https://azoffshowy.github.io/dangbro/)**

## How it works

1. Enter your TV's local IP in the web UI
2. Accept the SSAP pairing prompt on the TV
3. dangbro-autoroot establishes root, installs [Homebrew Channel](https://github.com/webosbrew/webos-homebrew-channel) and removes Developer-Mode app if installed.
4. On TV a dialog with results will be displayed. On success a reboot is needed to make root access persistent.
5. After reboot, check within Homebrew Channel settings, it should state "Root OK".

The exploit path uses the vulnerable `dangbei-overlay` app as well as the `legacy-broadcast` service.

## Prerequisites

- LG webOS TV reachable on your LAN
- Browser that supports WebSockets (Chrome recommended — self-signed cert acceptance required)

## Supported webOS

Only TVs with DVB-Tuner! The tool checks this automatically.

Currently confirmed on:

- webOS 25 (`10.2.1`,`10.3.0`)
- webOS 24 (`9.2.2`)
- webOS 7 (`7.5.x`)

Other versions may or may not work yet.

If you try dangbro on another webOS version, please report your TV model, webOS version, and result in the [OpenLGTV Discord](https://discord.gg/hXMHAgJC5R) so compatibility can be tracked and added here.

## Debug mode

Append `?debug` to the launcher URL before clicking connect:

```
https://azoffshowy.github.io/dangbro/?debug
```

If the exploit fails, the log (`/tmp/dangbro-root.log`) is automatically uploaded to [paste.rs](https://paste.rs) and the resulting URL is shown in the TV's alert dialog. The browser log panel also shows a `[debug mode — log upload enabled]` marker at startup.

Log upload only triggers on **failure**. On success the log stays on the TV at `/tmp/dangbro-root.log`.

## Troubleshooting

- **Nothing happens on TV after launch**: the `dangbei-overlay` app may not exist on your firmware. Check whether the service is present / other rooting options.
- **Root setup failed**: check `/tmp/dangbro-root.log` on the TV, or re-run in debug mode (see above) to get a shareable log URL.
- **Rooting complete but no Homebrew Channel**: reboot the TV. Make sure **Quick Start+** is disabled (`Settings → General → Quick Start+`).
- **IPK install error (errorCode -5)**: the TV's date/time is too far off. Correct it and retry.
- **Certificate blocked / WSS fails instantly**: open `https://<TV-IP>:3001/` in your browser first and accept the self-signed certificate.

If dangbro-autoroot doesn't support your TV, see the alternative exploits below.

## Alternative exploits

| Tool | Affected versions |
|---|---|
| [dejavuln-autoroot](https://github.com/throwaway96/dejavuln-autoroot) | webOS 3.5 – 8 (many 5+ models patched) |
| [faultmanager-autoroot](https://github.com/throwaway96/faultmanager-autoroot) | webOS 4.0 – 10.0 (most 5+ patched) |
| [mvpd-autoroot](https://github.com/throwaway96/mvpd-autoroot) | webOS 1 – 3.4.2 |

[CanI.RootMy.TV](https://cani.rootmy.tv/) can be used to determine which one is applicable for you.

## Support

For help rooting your TV, join the [OpenLGTV Discord](https://discord.gg/hXMHAgJC5R) and check #faq first. When asking for help, attach your `dangbro-root.log` (or the paste.rs URL from debug mode).

## Credits

Root persistence via [webosbrew/webos-homebrew-channel](https://github.com/webosbrew/webos-homebrew-channel).
Browser SSAP websocket proxy approach inspired by [Informatic/webos-ssap-web](https://github.com/Informatic/webos-ssap-web).
