const NodeHelper = require("node_helper");
const fs = require("fs");
const path = require("path");

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

    getTrains: async function(payload) {
        const { apiKey, stopId, routeId } = payload;

        try {
            const url = `https://api.transport.nsw.gov.au/v1/tp/departure_mon?outputFormat=rapidJSON&coordOutputFormat=EPSG%3A4326&mode=direct&type_dm=stop&name_dm=${stopId}&departureMonitorMacro=true&TfNSWDM=true&version=10.2.1.42`;

            const response = await fetch(url, {
                headers: {
                    'Authorization': `apikey ${apiKey}`,
                    'Accept': 'application/json'
                }
            });

            if (!response.ok) {
                throw new Error(`API Error: ${response.status} ${response.statusText}`);
            }

            const data = await response.json();

            this.sendSocketNotification("TRAINS_DATA", {
                routeId: routeId,
                data: data
            });

        } catch (error) {
            console.error("Error fetching trains:", error);
            this.sendSocketNotification("TRAINS_ERROR", {
                routeId: routeId,
                error: error.message
            });
        }
    }
});
