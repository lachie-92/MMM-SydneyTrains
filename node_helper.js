const NodeHelper = require("node_helper");
const fs = require("fs");
const path = require("path");

const API_URL = "https://api.transport.nsw.gov.au/v1/tp/";
const TRAIN_CLASSES = [1, 2]; // Trains and Sydney Metro
const WALK_CLASSES = [99, 100]; // Walking between platforms
const ALERT_PRIORITIES = ["high", "veryHigh"]; // Skips routine notices like station updates
const MAX_ALERTS = 2;

module.exports = NodeHelper.create({
    start: function() {
        console.log("Starting node helper for: " + this.name);
    },

    socketNotificationReceived: function(notification, payload) {
        if (notification === "LOAD_ROUTES") {
            this.loadRoutes(payload.routesFile);
        } else if (notification === "GET_TRAINS") {
            this.getTrains(payload);
        }
    },

    loadRoutes: function(routesFile) {
        try {
            const routesPath = path.join(__dirname, routesFile);

            if (!fs.existsSync(routesPath)) {
                this.sendSocketNotification("ROUTES_ERROR", "Routes file not found: " + routesFile + " (copy routes.example.json to get started)");
                return;
            }

            const routesData = fs.readFileSync(routesPath, "utf8");
            const routes = JSON.parse(routesData);

            this.sendSocketNotification("ROUTES_LOADED", routes);
        } catch (error) {
            console.error("Error loading routes:", error);
            this.sendSocketNotification("ROUTES_ERROR", error.message);
        }
    },

    // Routes with a toStopId use the trip planner, which also gives arrival times.
    // Others use the departure board for the stop.
    getTrains: async function(payload) {
        const { apiKey, route, count } = payload;

        try {
            const data = route.toStopId
                ? await this.getTrips(apiKey, route, count)
                : await this.getDepartures(apiKey, route);

            this.sendSocketNotification("TRAINS_DATA", {
                routeId: route.id,
                trains: data.trains,
                alerts: data.alerts
            });

        } catch (error) {
            console.error("Error fetching trains:", error);
            this.sendSocketNotification("TRAINS_ERROR", {
                routeId: route.id,
                error: error.message
            });
        }
    },

    getDepartures: async function(apiKey, route) {
        const data = await this.request(apiKey, "departure_mon", {
            mode: "direct",
            type_dm: "stop",
            name_dm: route.stopId,
            departureMonitorMacro: "true",
            TfNSWDM: "true"
        });

        // Stations' departure boards include buses from nearby stands
        const events = (data.stopEvents || []).filter(event =>
            TRAIN_CLASSES.includes(event.transportation?.product?.class) && matchesFilters(event.transportation, route));

        return {
            trains: events.map(event => ({
                line: lineName(event.transportation),
                from: stationName(event.location),
                fromPlatform: platformName(event.location),
                to: event.transportation?.destination?.name || "Unknown",
                departurePlanned: event.departureTimePlanned,
                departureEstimated: event.departureTimeEstimated,
                realtime: event.isRealtimeControlled === true,
                cancelled: isCancelled(event.realtimeStatus),
                occupancy: event.location?.properties?.occupancy || null
            })),
            alerts: collectAlerts(events)
        };
    },

    getTrips: async function(apiKey, route, count) {
        const now = sydneyTime();
        const data = await this.request(apiKey, "trip", {
            depArrMacro: "dep",
            itdDate: now.date,
            itdTime: now.time,
            type_origin: "stop",
            name_origin: route.stopId,
            type_destination: "stop",
            name_destination: route.toStopId,
            calcNumberOfTrips: count + 2, // a few spare in case some need a change
            excludedMeans: "checkbox",
            exclMOT_4: "1", // light rail
            exclMOT_5: "1", // buses
            exclMOT_7: "1", // coaches
            exclMOT_9: "1", // ferries
            exclMOT_11: "1", // school buses
            TfNSWTR: "true"
        });

        const legs = (data.journeys || [])
            .map(directTrainLeg)
            .filter(leg => leg && matchesFilters(leg.transportation, route));

        return {
            trains: legs.map(leg => {
                const origin = leg.origin.properties || {};
                return {
                    line: lineName(leg.transportation),
                    from: stationName(leg.origin),
                    fromPlatform: platformName(leg.origin),
                    to: stationName(leg.destination),
                    toPlatform: platformName(leg.destination),
                    departurePlanned: leg.origin.departureTimePlanned,
                    departureEstimated: leg.origin.departureTimeEstimated,
                    arrivalPlanned: leg.destination.arrivalTimePlanned,
                    arrivalEstimated: leg.destination.arrivalTimeEstimated,
                    realtime: leg.isRealtimeControlled === true,
                    cancelled: isCancelled(leg.realtimeStatus),
                    occupancy: origin.occupancy || null,
                    cars: Number(origin.NumberOfCars) || null,
                    carsFrom: Number(origin.TravelInCarsFrom) || null,
                    carsTo: Number(origin.TravelInCarsTo) || null
                };
            }),
            alerts: collectAlerts(legs)
        };
    },

    request: async function(apiKey, endpoint, params) {
        const query = new URLSearchParams(Object.assign({
            outputFormat: "rapidJSON",
            coordOutputFormat: "EPSG:4326",
            version: "10.2.1.42"
        }, params));

        const response = await fetch(API_URL + endpoint + "?" + query, {
            headers: {
                'Authorization': `apikey ${apiKey}`,
                'Accept': 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error(`API Error: ${response.status} ${response.statusText}`);
        }

        return response.json();
    }
});

// The one train in a journey with no changes, or null if it needs a change or isn't by train
function directTrainLeg(journey) {
    const rides = journey.legs.filter(leg => !WALK_CLASSES.includes(leg.transportation?.product?.class));
    if (rides.length !== 1 || !TRAIN_CLASSES.includes(rides[0].transportation?.product?.class)) {
        return null;
    }
    return rides[0];
}

function matchesFilters(transportation, route) {
    // Filter by line if specified
    if (route.lineFilter) {
        const line = transportation?.number || '';
        if (!line.toLowerCase().includes(route.lineFilter.toLowerCase())) {
            return false;
        }
    }

    // Filter by the train's final destination if specified
    if (route.destinationFilter) {
        const destination = transportation?.destination?.name || '';
        if (!destination.toLowerCase().includes(route.destinationFilter.toLowerCase())) {
            return false;
        }
    }

    return true;
}

// "T4" rather than "T4 Eastern Suburbs & Illawarra Line"
function lineName(transportation) {
    return transportation?.disassembledName || (transportation?.number || '').split(' ')[0];
}

// "Kirrawee Station, Platform 1, Kirrawee" -> "Kirrawee". Some stations only
// have the platform in disassembledName (", Platform 2"), so name is the fallback.
function stationName(location) {
    const name = [location?.disassembledName, location?.name]
        .map(text => (text || '').split(',')[0].trim())
        .find(Boolean);
    return name ? name.replace(/ Station$/, '') : 'Unknown';
}

// "Platform 1" rather than the platform code ("KRW1")
function platformName(location) {
    const properties = location?.properties || {};
    if (properties.platformName) {
        return properties.platformName;
    }
    return properties.platform ? 'Platform ' + properties.platform : null;
}

function isCancelled(realtimeStatus) {
    return [].concat(realtimeStatus || []).some(status => String(status).includes("CANCEL"));
}

// Important alerts for the route's services, without repeats
function collectAlerts(services) {
    const alerts = [];
    services.forEach(service => {
        (service.infos || []).forEach(info => {
            const title = info.subtitle || info.urlText;
            if (title && ALERT_PRIORITIES.includes(info.priority) && !alerts.includes(title)) {
                alerts.push(title);
            }
        });
    });
    return alerts.slice(0, MAX_ALERTS);
}

// The trip planner wants Sydney's date and time, whatever the mirror's time zone
function sydneyTime() {
    const parts = {};
    new Intl.DateTimeFormat("en-AU", {
        timeZone: "Australia/Sydney",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
    }).formatToParts(new Date()).forEach(part => {
        parts[part.type] = part.value;
    });
    return { date: parts.year + parts.month + parts.day, time: parts.hour + parts.minute };
}
