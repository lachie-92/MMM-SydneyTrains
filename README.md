# MMM-SydneyTrains

A [MagicMirror²](https://magicmirror.builders/) module that shows real-time Sydney Trains departures from the Transport for NSW API.

![Screenshot](screenshot.png)

## Features

- Show several routes or stations at once
- Filter each route by line (e.g. `T1`) and destination
- Real-time delay information, with delayed services highlighted
- Routes live in a separate `routes.json` file, picked up on the next refresh without restarting the mirror

## Requirements

This module uses the [Transport for NSW Open Data Hub](https://opendata.transport.nsw.gov.au/) **Trip Planner APIs** (departure monitor endpoint).

- You need a free API key: register on the Open Data Hub, create an application, and add the **Trip Planner APIs** to it.
- The free plan has request quotas; check the current limits on the portal. With the default settings the module makes one request per route every 60 seconds (about 1,440 requests per route per day).

The module uses the built-in `fetch` in Node.js, so it has no npm dependencies.

## Installation

```bash
cd ~/MagicMirror/modules
git clone https://github.com/lachie-92/MMM-SydneyTrains.git
cd MMM-SydneyTrains
cp routes.example.json routes.json
```

Then edit `routes.json` (see [Routes](#routes)) and add the module to your config.

## Configuration

Add this to the `modules` array in `~/MagicMirror/config/config.js`:

```javascript
{
    module: "MMM-SydneyTrains",
    position: "top_right",
    config: {
        apiKey: "YOUR_TFNSW_API_KEY"
    }
}
```

| Option | Default | Description |
| --- | --- | --- |
| `apiKey` | `""` | **Required.** Your Transport for NSW API key. |
| `updateInterval` | `60000` | How often to refresh, in milliseconds. 30000 (30 seconds) or more is recommended. |
| `maxTrainsPerRoute` | `6` | Maximum number of departures shown per route. |
| `animationSpeed` | `1000` | Fade speed when the display updates, in milliseconds. |
| `routesFile` | `"routes.json"` | Routes file name, relative to the module folder. |

## Routes

Each entry in `routes.json` is shown as its own section on the mirror:

```json
[
    {
        "id": "central-t1-west",
        "name": "Central to Penrith",
        "stopId": "10101100",
        "lineFilter": "T1",
        "destinationFilter": "Penrith"
    }
]
```

| Field | Required | Description |
| --- | --- | --- |
| `id` | Yes | Unique identifier for the route. |
| `name` | Yes | Heading shown on the mirror. |
| `stopId` | Yes | Transport for NSW stop ID for the station. |
| `lineFilter` | No | Only show this line (e.g. `T1`, `T4`). Leave empty for all lines. |
| `destinationFilter` | No | Only show services whose destination contains this text. Leave empty for all destinations. |

Changes to `routes.json` are picked up on the next refresh, so there's no need to restart MagicMirror².

### Finding stop IDs

Some common stop IDs:

- Central: `10101100`
- Town Hall: `10101120`
- Wynyard: `10101121`
- Circular Quay: `10101122`
- St James: `10101123`
- Redfern: `10101293`
- Strathfield: `10101331`

Other stations can be looked up through the [Transport for NSW Open Data Hub](https://opendata.transport.nsw.gov.au/).

## Updating

```bash
cd ~/MagicMirror/modules/MMM-SydneyTrains
git pull
```

Your `routes.json` is not tracked by git, so updating won't overwrite it.

## Customisation

Override any styles from `MMM-SydneyTrains.css` in `~/MagicMirror/config/custom.css`, so they survive updates.

## Troubleshooting

- **"API key not configured"**: add `apiKey` to the module's `config` block.
- **"Routes file not found"**: run `cp routes.example.json routes.json` in the module folder.
- **No trains showing**: check your API key, the stop ID, and that your filters aren't excluding every service.
- **Routes not loading**: make sure `routes.json` is valid JSON.
- **Module not appearing**: check the MagicMirror² logs (e.g. `pm2 logs mm`).

## License

[MIT](LICENSE)
