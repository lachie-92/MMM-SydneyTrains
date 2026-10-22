// MMM-SydneyTrains.js
Module.register("MMM-SydneyTrains", {
    defaults: {
        apiKey: "",
        updateInterval: 60000, // 1 minute
        maxTrainsPerRoute: 6,
        animationSpeed: 1000,
        routesFile: "routes.json", // External routes configuration
        showOccupancy: true,
        showAlerts: true,
        timeFormat: config.timeFormat
    },

    // Line colours for the countdown tiles. Other lines use Sydney Trains orange.
    lineColours: {
        T1: "#f99d1c",
        T2: "#0098cd",
        T3: "#f37021",
        T4: "#005aa3",
        T5: "#c4258f",
        T7: "#6f818e",
        T8: "#00954c",
        T9: "#d11f2f",
        M1: "#168388"
    },

    // How full the train is, shown as one to three people
    occupancyLevels: {
        EMPTY: 1,
        MANY_SEATS: 1,
        FEW_SEATS: 2,
        STANDING_ONLY: 3,
        CRUSHED_STANDING: 3,
        FULL: 3
    },

    start: function() {
        Log.info("Starting module: " + this.name);
        this.trains = {};
        this.routeErrors = {};
        this.routes = [];
        this.routesLoaded = false;
        this.error = null;

        this.loadRoutes();
        this.scheduleUpdate();
    },

    getStyles: function() {
        return ["font-awesome.css", "MMM-SydneyTrains.css"];
    },

    loadRoutes: function() {
        this.sendSocketNotification("LOAD_ROUTES", {
            routesFile: this.config.routesFile
        });
    },

    scheduleUpdate: function() {
        var self = this;

        // Reload routes each cycle so edits to routes.json apply without a restart
        setInterval(function() {
            self.loadRoutes();
        }, this.config.updateInterval);

        // Redraw between updates so the countdowns stay current.
        // MagicMirror skips the redraw when nothing has changed.
        setInterval(function() {
            self.updateDom();
        }, 15000);

        // Initial update
        this.updateTrains();
    },

    updateTrains: function() {
        if (!this.config.apiKey) {
            this.error = "API key not configured";
            this.updateDom(this.config.animationSpeed);
            return;
        }

        if (this.routes.length === 0) {
            return;
        }

        this.routes.forEach(route => {
            this.sendSocketNotification("GET_TRAINS", {
                apiKey: this.config.apiKey,
                route: route,
                count: this.config.maxTrainsPerRoute
            });
        });
    },

    socketNotificationReceived: function(notification, payload) {
        if (notification === "ROUTES_LOADED") {
            this.routes = payload;
            this.routesLoaded = true;
            this.error = null;
            Log.info("Loaded " + this.routes.length + " routes");
            this.updateTrains();
        } else if (notification === "ROUTES_ERROR") {
            this.error = "Error loading routes: " + payload;
            this.updateDom(this.config.animationSpeed);
        } else if (notification === "TRAINS_DATA") {
            this.trains[payload.routeId] = payload;
            this.routeErrors[payload.routeId] = null;
            this.updateDom(this.config.animationSpeed);
        } else if (notification === "TRAINS_ERROR") {
            // Keep showing the last trains, with a note that the update failed
            this.routeErrors[payload.routeId] = payload.error;
            this.updateDom(this.config.animationSpeed);
        }
    },

    getDom: function() {
        var wrapper = this.createElement("div", "sydney-trains");

        if (this.error) {
            wrapper.appendChild(this.createElement("div", "error", this.error));
            return wrapper;
        }

        if (!this.routesLoaded) {
            wrapper.appendChild(this.createElement("div", "loading", "Loading trains..."));
            return wrapper;
        }

        this.routes.forEach(route => {
            wrapper.appendChild(this.createRouteDisplay(route));
        });

        return wrapper;
    },

    createRouteDisplay: function(route) {
        var routeData = this.trains[route.id];
        var routeError = this.routeErrors[route.id];

        var routeContainer = this.createElement("div", "route-container");

        // Route header
        var header = this.createElement("div", "route-header");
        header.appendChild(this.createElement("i", "fa-solid fa-train"));
        header.appendChild(document.createTextNode(route.name));
        routeContainer.appendChild(header);

        if (!routeData) {
            routeContainer.appendChild(this.createElement("div", routeError ? "error" : "loading", routeError || "Loading trains..."));
            return routeContainer;
        }

        if (this.config.showAlerts) {
            routeData.alerts.forEach(alert => {
                var alertDiv = this.createElement("div", "route-alert");
                alertDiv.appendChild(this.createElement("i", "fa-solid fa-triangle-exclamation"));
                alertDiv.appendChild(document.createTextNode(alert));
                routeContainer.appendChild(alertDiv);
            });
        }

        // Trains drop off 30 seconds after they leave
        var now = Date.now();
        var trains = routeData.trains
            .filter(train => this.departureTime(train) > now - 30000)
            .slice(0, this.config.maxTrainsPerRoute);

        if (trains.length === 0) {
            routeContainer.appendChild(this.createElement("div", "no-trains", "No upcoming trains"));
        } else {
            // Pickup and drop-off stations, once above the times
            var places = this.createElement("div", "places");
            places.appendChild(this.createElement("span", "from", trains[0].from));
            if (trains[0].arrivalPlanned) {
                places.appendChild(this.createElement("span", "to", trains[0].to));
            }
            routeContainer.appendChild(places);
        }

        var trainList = this.createElement("div", "train-list");
        trains.forEach(train => {
            trainList.appendChild(this.createTrainItem(train, route, now));
        });
        routeContainer.appendChild(trainList);

        if (routeError) {
            routeContainer.appendChild(this.createElement("div", "update-failed", "Update failed: " + routeError));
        }

        return routeContainer;
    },

    createTrainItem: function(train, route, now) {
        var departure = this.departureTime(train);
        var minutesUntil = Math.round((departure - now) / 60000);
        var leaveIn = route.walkMinutes != null ? minutesUntil - route.walkMinutes : null;
        var colour = route.colour || this.lineColours[train.line] || "#f37021";

        var item = this.createElement("div", "train-item");
        item.style.setProperty("--line-colour", colour);
        item.style.setProperty("--line-text", this.textColourFor(colour));
        if (train.cancelled) {
            item.classList.add("cancelled");
        } else if (leaveIn != null && leaveIn < 0) {
            item.classList.add("missed");
        } else if (leaveIn === 0) {
            item.classList.add("leave-now");
        }

        item.appendChild(this.createCountdown(minutesUntil, train.cancelled));

        var body = this.createElement("div", "train-body");

        // Departure and arrival times with the trip length between them,
        // or where the train is going for routes without a toStopId
        var times = this.createElement("div", "train-row times");
        times.appendChild(this.createElement("span", "depart", this.formatTime(departure)));
        if (train.arrivalPlanned) {
            var arrival = new Date(train.arrivalEstimated || train.arrivalPlanned).getTime();
            var journey = this.createElement("span", "journey");
            journey.appendChild(this.createElement("span", "journey-length", Math.round((arrival - departure) / 60000) + " min"));
            times.appendChild(journey);
            times.appendChild(this.createElement("span", "arrive", this.formatTime(arrival)));
        } else {
            times.appendChild(this.createElement("span", "terminus", train.to));
        }
        body.appendChild(times);

        // Status, how full it is and the line
        var statusRow = this.createElement("div", "train-row status-row");
        statusRow.appendChild(this.createStatus(train, leaveIn));

        var extras = this.createElement("span", "extras");
        var cars = this.carsText(train);
        if (cars) {
            extras.appendChild(this.createElement("span", "cars", cars));
        }
        var occupancy = this.occupancyLevels[train.occupancy];
        if (this.config.showOccupancy && occupancy) {
            extras.appendChild(this.createOccupancy(occupancy));
        }
        if (train.line) {
            extras.appendChild(this.createElement("span", "line-badge", train.line));
        }
        statusRow.appendChild(extras);
        body.appendChild(statusRow);

        item.appendChild(body);
        return item;
    },

    createCountdown: function(minutesUntil, cancelled) {
        var countdown = this.createElement("div", "countdown");
        var value;
        var unit = null;

        if (cancelled) {
            value = "–";
        } else if (minutesUntil < 1) {
            value = "Now";
        } else if (minutesUntil < 100) {
            value = minutesUntil;
            unit = minutesUntil === 1 ? "min" : "mins";
        } else {
            value = Math.floor(minutesUntil / 60);
            unit = value === 1 ? "hr" : "hrs";
        }

        countdown.appendChild(this.createElement("span", "countdown-value", value));
        if (unit) {
            countdown.appendChild(this.createElement("span", "countdown-unit", unit));
        }
        return countdown;
    },

    createStatus: function(train, leaveIn) {
        var delay = train.realtime ? this.delayMinutes(train) : 0;
        var state;
        var text;

        if (train.cancelled) {
            state = "cancelled";
            text = "Cancelled";
        } else if (!train.realtime) {
            state = "scheduled";
            text = "Scheduled";
        } else if (delay > 0) {
            state = delay >= 5 ? "late" : "slightly-late";
            text = delay + " min late";
        } else if (delay < 0) {
            state = "early";
            text = -delay + " min early";
        } else {
            state = "on-time";
            text = "On time";
        }

        var status = this.createElement("span", "status");
        status.appendChild(this.createElement("span", "status-light " + state));
        status.appendChild(document.createTextNode(text));

        if (train.fromPlatform) {
            status.appendChild(this.createElement("span", "platform", train.fromPlatform));
        }

        // With walkMinutes set, when to head out the door
        if (leaveIn != null && !train.cancelled) {
            var leave = leaveIn < 0 ? "Too late" : leaveIn === 0 ? "Leave now" : "Leave in " + leaveIn + " min";
            status.appendChild(this.createElement("span", "leave", leave));
        }

        return status;
    },

    createOccupancy: function(level) {
        var occupancy = this.createElement("span", "occupancy level-" + level);
        for (var i = 1; i <= 3; i++) {
            occupancy.appendChild(this.createElement("i", "fa-solid fa-person" + (i <= level ? " filled" : "")));
        }
        return occupancy;
    },

    // Where to stand at short platforms, or a warning about a short train
    carsText: function(train) {
        if (train.cars && train.carsFrom && train.carsTo && train.carsTo - train.carsFrom + 1 < train.cars) {
            return "Use cars " + train.carsFrom + "–" + train.carsTo;
        }
        if (train.cars && train.cars < 8) {
            return train.cars + " cars";
        }
        return null;
    },

    departureTime: function(train) {
        return new Date(train.departureEstimated || train.departurePlanned).getTime();
    },

    delayMinutes: function(train) {
        if (!train.departurePlanned || !train.departureEstimated) {
            return 0;
        }
        return Math.round((new Date(train.departureEstimated) - new Date(train.departurePlanned)) / 60000);
    },

    // Black or white text, whichever is easier to read on the line colour
    textColourFor: function(colour) {
        if (!/^#[0-9a-f]{6}$/i.test(colour)) {
            return "#fff";
        }
        var rgb = colour.slice(1).match(/../g).map(part => parseInt(part, 16) / 255);
        var luminance = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
        return luminance > 0.55 ? "#000" : "#fff";
    },

    formatTime: function(time) {
        return new Date(time).toLocaleTimeString("en-AU", {
            hour: "numeric",
            minute: "2-digit",
            hour12: this.config.timeFormat !== 24
        });
    },

    createElement: function(tag, className, text) {
        var element = document.createElement(tag);
        if (className) {
            element.className = className;
        }
        if (text != null) {
            element.textContent = text;
        }
        return element;
    }
});
