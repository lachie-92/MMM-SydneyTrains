const NodeHelper = require("node_helper");
const fs = require("fs");
const path = require("path");

const API_URL = "https://api.transport.nsw.gov.au/v1/tp/";
const TRAIN_CLASSES = [1, 2]; // Trains and Sydney Metro
const WALK_CLASSES = [99, 100]; // Walking between platforms
const ALERT_PRIORITIES = ["high", "veryHigh"]; // Skips routine notices like station updates
const MAX_ALERTS = 2;
const TRACKWORK_REFRESH = 30 * 60 * 1000; // The trackwork feed is large and rarely changes
const DAY_MS = 24 * 60 * 60 * 1000;

module.exports = NodeHelper.create({
    start: function() {
        console.log("Starting node helper for: " + this.name);
    },

    socketNotificationReceived: function(notification, payload) {
        if (notification === "LOAD_ROUTES") {
            this.loadRoutes(payload.routesFile);
        } else if (notification === "GET_TRAINS") {
            this.getTrains(payload);
        } else if (notification === "GET_TRACKWORK") {
            this.getTrackwork(payload);
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

    // Planned trackwork on the given lines this weekend. Nothing is sent
    // Monday to Wednesday, as the notice only shows from Thursday.
    getTrackwork: async function(payload) {
        const { apiKey, lines } = payload;
        const weekend = upcomingWeekend();

        if (!weekend) {
            this.sendSocketNotification("TRACKWORK_DATA", { weekend: false, lines: lines, notices: [] });
            return;
        }

        try {
            if (!this.trackwork || Date.now() - this.trackwork.time > TRACKWORK_REFRESH) {
                // Trains (1) and Sydney Metro (2) are separate requests
                const feeds = await Promise.all(["1", "2"].map(type => this.request(apiKey, "add_info", {
                    filterMOTType: type,
                    filterInfoType: "lineInfo",
                    filterPublicationStatus: "current"
                })));
                this.trackwork = {
                    time: Date.now(),
                    infos: feeds
                        .flatMap(data => data.infos?.current || [])
                        .filter(info => info.properties?.announcementType === "trackwork")
                };
            }

            const notices = [];
            this.trackwork.infos.forEach(info => {
                const windows = (info.timestamps?.validity || []).filter(window => overlaps(window, weekend.start, weekend.end));
                if (windows.length === 0) {
                    return;
                }

                const infoLines = (info.affected?.lines || []).map(lineName);
                lines.filter(line => infoLines.includes(line)).forEach(line => {
                    notices.push({
                        line: line,
                        title: headline(info.subtitle || info.urlText || ''),
                        buses: /buses replace/i.test(info.subtitle || ''),
                        allWeekend: windows.some(window => covers(window, weekend.saturday, weekend.sundayEnd)),
                        windows: windows.map(window => ({ from: window.from, to: window.to }))
                    });
                });
            });

            // The same notice can be listed once per direction
            const unique = notices.filter((notice, index) => notices.findIndex(other =>
                other.line === notice.line && other.title === notice.title && JSON.stringify(other.windows) === JSON.stringify(notice.windows)) === index);
            unique.sort((a, b) => new Date(a.windows[0].from) - new Date(b.windows[0].from));

            this.sendSocketNotification("TRACKWORK_DATA", { weekend: true, lines: lines, notices: unique });

        } catch (error) {
            console.error("Error fetching trackwork:", error);
            this.sendSocketNotification("TRACKWORK_ERROR", { error: error.message });
        }
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

// "Trains run to a changed timetable. You may need to change trains" -> "Trains run to a changed timetable"
function headline(text) {
    return text
        .split('. ')[0]
        .replace(/\.$/, '')
        .replace(/&amp;/g, '&')
        .replace(/&#39;|&rsquo;/g, "'")
        .trim();
}

// Sydney's date and time, whatever the mirror's time zone
function sydneyParts(date) {
    const parts = {};
    new Intl.DateTimeFormat("en-AU", {
        timeZone: "Australia/Sydney",
        weekday: "short",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
    }).formatToParts(date).forEach(part => {
        parts[part.type] = part.value;
    });
    return parts;
}

// The trip planner wants Sydney's date and time
function sydneyTime() {
    const parts = sydneyParts(new Date());
    return { date: parts.year + parts.month + parts.day, time: parts.hour + parts.minute };
}

// Sydney wall-clock time as a number like 202610241430, so times can be
// compared without converting time zones
function sydneyStamp(time) {
    const parts = sydneyParts(new Date(time));
    return Number(parts.year + parts.month + parts.day + parts.hour + parts.minute);
}

// A date (as a UTC day) and time of day as the same kind of number
function dayStamp(day, hour) {
    const date = new Date(day);
    const pad = number => String(number).padStart(2, '0');
    return Number(date.getUTCFullYear() + pad(date.getUTCMonth() + 1) + pad(date.getUTCDate()) + pad(hour) + '00');
}

// This weekend, from Friday 6 pm to Monday 4 am in Sydney. Null Monday to
// Wednesday, as the notice only shows from Thursday.
function upcomingWeekend() {
    const now = sydneyParts(new Date());
    const daysToSaturday = { Thu: 2, Fri: 1, Sat: 0, Sun: -1 }[now.weekday];
    if (daysToSaturday === undefined) {
        return null;
    }

    const saturday = Date.UTC(Number(now.year), Number(now.month) - 1, Number(now.day) + daysToSaturday);
    return {
        start: dayStamp(saturday - DAY_MS, 18),
        saturday: dayStamp(saturday, 4),
        sundayEnd: dayStamp(saturday + 2 * DAY_MS, 0),
        end: dayStamp(saturday + 2 * DAY_MS, 4)
    };
}

function overlaps(window, start, end) {
    return sydneyStamp(window.from) < end && sydneyStamp(window.to) > start;
}

function covers(window, start, end) {
    return sydneyStamp(window.from) <= start && sydneyStamp(window.to) >= end;
}
