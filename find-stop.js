// Finds the stop ID of a train or metro station, for routes.json.
// Usage: node find-stop.js "Town Hall" YOUR_API_KEY
// The API key can also come from the TFNSW_API_KEY environment variable.

const API_URL = "https://api.transport.nsw.gov.au/v1/tp/";
const TRAIN_CLASSES = [1, 2]; // Trains and Sydney Metro

const [search, apiKey = process.env.TFNSW_API_KEY] = process.argv.slice(2);

if (!search || !apiKey) {
    console.log('Usage: node find-stop.js "Town Hall" YOUR_API_KEY');
    process.exit(1);
}

async function request(endpoint, params) {
    const query = new URLSearchParams(Object.assign({
        outputFormat: "rapidJSON",
        coordOutputFormat: "EPSG:4326",
        version: "10.2.1.42"
    }, params));

    const response = await fetch(API_URL + endpoint + "?" + query, {
        headers: { 'Authorization': `apikey ${apiKey}` }
    });

    if (!response.ok) {
        throw new Error(`API Error: ${response.status} ${response.statusText}`);
    }
    return response.json();
}

(async () => {
    const found = await request("stop_finder", { type_sf: "any", name_sf: search, TfNSWSF: "true" });
    const stations = (found.locations || [])
        .filter(location => location.type === "stop" && (location.modes || []).some(mode => TRAIN_CLASSES.includes(mode)))
        .slice(0, 5);

    if (stations.length === 0) {
        console.log(`No train or metro stations found for "${search}"`);
        return;
    }

    // The stop finder gives the whole station's ID. Routes use the ID of its
    // train platforms, which the station's departure board shows.
    for (const station of stations) {
        const board = await request("departure_mon", {
            mode: "direct",
            type_dm: "stop",
            name_dm: station.id,
            departureMonitorMacro: "true",
            TfNSWDM: "true"
        });
        const train = (board.stopEvents || []).find(event => TRAIN_CLASSES.includes(event.transportation?.product?.class));
        const stopId = train?.location?.properties?.stopId;
        console.log(`${station.name}: ${stopId || "no trains departing soon, try again later"}`);
    }
})().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
