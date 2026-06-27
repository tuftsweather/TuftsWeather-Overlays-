# TuftsWeather Overlays

Local browser overlays for weather coverage. Includes a dashboard, warning banners, popup alerts, counters, warning strips, tropical/winter scenes, SPC outlook views, and warned camera widgets.

## What Is Included

- Dashboard at `http://127.0.0.1:4318/`
- Severe weather overlays
- Tropical overlays
- Winter overlays
- SPC outlook overlays
- Warned camera widgets
- Optional NWWS support
- Public NWS API fallback when NWWS credentials are blank

## What Is Not Included

This public copy does not include private credentials, local cache files, logs, `node_modules`, build output, or the local parser database.

Do not commit:

- `config/localoverlays.local.json`
- `config/backups/`
- `node_modules/`
- `dist/`
- `storage/parser/shapefiles.db`
- `*.log`

The `.gitignore` already blocks those files.

## Install

Install Node.js first. Then run one of these:

- Windows: `build-tools/install-windows.cmd`
- Git Bash / shell: `build-tools/install-shell.sh`

You can also run:

```bash
npm install
```

## Add Your NWWS Login

The repo includes the real default config here:

```text
config/localoverlays.json
```

Install/start will copy it to your private local settings file:

```text
config/localoverlays.local.json
```

Put your own credentials in `config/localoverlays.local.json`:

```json
{
  "nwws": {
    "enabled": true,
    "username": "YOUR_NWWS_USERNAME",
    "password": "YOUR_NWWS_PASSWORD",
    "nickname": "YourOverlayName"
  }
}
```

Leave `username` and `password` blank if you only want the public NWS API fallback.

Do not put credentials in `config/localoverlays.json`. That file is the shared default that updates can replace.

## Add Custom Camera / Chaser Streams

The easiest way is the dashboard:

```text
http://127.0.0.1:4318/
```

Open `Configuration > Custom Cameras`, add a camera, paste the YouTube livestream URL, choose Severe/Winter/Tropical, preview it, then save.

You can also edit `config/localoverlays.local.json` directly.

Each custom camera only needs a name and URL. Location is optional. Custom chasers rotate in as cutaways every few cameras instead of needing an exact warning polygon location.

```json
{
  "customCameras": {
    "enabled": true,
    "items": [
      {
        "enabled": true,
        "name": "Example Chaser",
        "url": "https://www.youtube.com/embed/VIDEO_ID?autoplay=1&mute=1",
        "widgets": {
          "severe": true,
          "winter": false,
          "tropical": true
        }
      }
    ]
  }
}
```

You can also paste a normal YouTube watch URL like `https://www.youtube.com/watch?v=VIDEO_ID`; the server will convert it to an embed URL automatically.

Restart TuftsWeather Overlays after changing the config.

## Change Feed Settings

The dashboard also has `Configuration > Feeds` for NWWS and NWS API settings. You can set NWWS username/password/nickname, toggle NWWS, toggle the NWS API fallback, and change polling intervals.

After saving feed settings, restart TuftsWeather Overlays so the parser reconnects with the new settings.

## Start

- Windows: `build-tools/start-windows.cmd`
- Git Bash / shell: `build-tools/start-shell.sh`

Or run:

```bash
npm run start
```

The dashboard opens at:

```text
http://127.0.0.1:4318/
```

The shortcut server also tries to make this work:

```text
http://localhost/
```

## Update

If you installed this from GitHub with Git, run one of these to update to the latest version:

- Windows: `build-tools/update-windows.cmd`
- Git Bash / shell: `build-tools/update-shell.sh`

The updater runs `git pull --ff-only`, `npm install`, and `npm run build`. It keeps your private `config/localoverlays.local.json` file and makes a quick backup in `config/backups/` before pulling.

## Build Dashboard

```bash
npm run build
```

The start script builds automatically if `dist/index.html` does not exist.

## Main Overlay URLs

- Severe banner: `http://127.0.0.1:4318/overlays/weather-warning-banner.html`
- Popup alerts: `http://127.0.0.1:4318/overlays/popup-alerts.html?setMaxHistory=2`
- Severe strip: `http://127.0.0.1:4318/overlays/active-warning-strip.html`
- Alert counter: `http://127.0.0.1:4318/overlays/alertactive.html`
- Tropical counter: `http://127.0.0.1:4318/overlays/tropicalactive.html`
- Tropical strip: `http://127.0.0.1:4318/overlays/tropical-warning-strip.html`
- Winter counter: `http://127.0.0.1:4318/overlays/winter-alert-counter.html`
- Winter strip: `http://127.0.0.1:4318/overlays/winter-active-strip.html`
- Warned cams: `http://127.0.0.1:4318/widgets/warnedcams`

More URLs are listed on the dashboard.
