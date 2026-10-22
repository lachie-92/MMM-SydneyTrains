// MMM-SydneyTrains.js
Module.register("MMM-SydneyTrains", {
    defaults: {
        apiKey: "",
        updateInterval: 60000, // 1 minute
        maxTrainsPerRoute: 6,
        animationSpeed: 1000,
        routesFile: "routes.json" // External routes configuration
    },

    start: function() {
        Log.info("Starting module: " + this.name);
        this.trains = {};
        this.routes = [];
        this.loaded = false;
        this.error = null;
        
        this.loadRoutes();
        this.scheduleUpdate();
    },

    getStyles: function() {
        return ["MMM-SydneyTrains.css"];
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
                stopId: route.stopId,
                routeId: route.id
            });
        });
    },

    socketNotificationReceived: function(notification, payload) {
        if (notification === "ROUTES_LOADED") {
            this.routes = payload;
            Log.info("Loaded " + this.routes.length + " routes");
            this.updateTrains();
        } else if (notification === "ROUTES_ERROR") {
            this.error = "Error loading routes: " + payload;
            this.updateDom(this.config.animationSpeed);
        } else if (notification === "TRAINS_DATA") {
            this.trains[payload.routeId] = payload.data;
            this.loaded = true;
            this.error = null;
            this.updateDom(this.config.animationSpeed);
        } else if (notification === "TRAINS_ERROR") {
            this.error = payload.error;
            this.updateDom(this.config.animationSpeed);
        }
    },

    getDom: function() {
        var wrapper = document.createElement("div");
        wrapper.className = "sydney-trains";

        if (this.error) {
            wrapper.innerHTML = '<div class="error">' + this.error + '</div>';
            return wrapper;
        }

        if (!this.loaded) {
            wrapper.innerHTML = '<div class="loading">Loading trains...</div>';
            return wrapper;
        }

        this.routes.forEach(route => {
            var routeDiv = this.createRouteDisplay(route);
            if (routeDiv) {
                wrapper.appendChild(routeDiv);
            }
        });

        return wrapper;
    },

    createRouteDisplay: function(route) {
        var routeData = this.trains[route.id];
        if (!routeData || !routeData.stopEvents) {
            return null;
        }

        var routeContainer = document.createElement("div");
        routeContainer.className = "route-container";

        // Route header
        var header = document.createElement("div");
        header.className = "route-header";
        header.innerHTML = '<i class="fas fa-train"></i> ' + route.name;
        routeContainer.appendChild(header);

        // Filter and process trains
        var trains = routeData.stopEvents
            .filter(event => this.filterTrain(event, route))
            .slice(0, this.config.maxTrainsPerRoute);

        if (trains.length === 0) {
            var noTrains = document.createElement("div");
            noTrains.className = "no-trains";
            noTrains.innerHTML = "No upcoming trains";
            routeContainer.appendChild(noTrains);
            return routeContainer;
        }

        // Create train list
        var trainList = document.createElement("div");
        trainList.className = "train-list";

        trains.forEach(train => {
            var trainItem = this.createTrainItem(train);
            trainList.appendChild(trainItem);
        });

        routeContainer.appendChild(trainList);
        return routeContainer;
    },

    filterTrain: function(event, route) {
        // Filter by line if specified
        if (route.lineFilter) {
            var line = event.transportation?.number || '';
            if (!line.toLowerCase().includes(route.lineFilter.toLowerCase())) {
                return false;
            }
        }

        // Filter by destination if specified
        if (route.destinationFilter) {
            var destination = event.transportation?.destination?.name || '';
            if (!destination.toLowerCase().includes(route.destinationFilter.toLowerCase())) {
                return false;
            }
        }

        return true;
    },

    createTrainItem: function(train) {
        var item = document.createElement("div");
        item.className = "train-item";

        var destination = train.transportation?.destination?.name || 'Unknown';
        var lineNumber = train.transportation?.number || '';
        var platform = train.location?.properties?.platform || 'TBA';

        // Calculate time and delay
        var departureTimePlanned = train.departureTimePlanned;
        var departureTimeEstimated = train.departureTimeEstimated;
        var displayTime = departureTimeEstimated || departureTimePlanned;

        var delayMinutes = 0;
        var isDelayed = false;

        if (departureTimePlanned && departureTimeEstimated) {
            var planned = new Date(departureTimePlanned);
            var estimated = new Date(departureTimeEstimated);
            delayMinutes = Math.round((estimated - planned) / 60000);
            isDelayed = delayMinutes > 0;
        }

        if (isDelayed) {
            item.classList.add("delayed");
        }

        // Time display
        var timeDiv = document.createElement("div");
        timeDiv.className = "train-time";
        
        var departureDate = new Date(displayTime);
        var now = new Date();
        var minutesUntil = Math.round((departureDate - now) / 60000);
        
        if (minutesUntil < 1) {
            timeDiv.innerHTML = "Now";
        } else if (minutesUntil < 60) {
            timeDiv.innerHTML = minutesUntil + " min";
        } else {
            timeDiv.innerHTML = departureDate.toLocaleTimeString('en-AU', { 
                hour: '2-digit', 
                minute: '2-digit' 
            });
        }
        
        item.appendChild(timeDiv);

        // Destination info
        var infoDiv = document.createElement("div");
        infoDiv.className = "train-info";
        
        var destSpan = document.createElement("span");
        destSpan.className = "destination";
        destSpan.innerHTML = destination;
        infoDiv.appendChild(destSpan);

        if (lineNumber) {
            var lineSpan = document.createElement("span");
            lineSpan.className = "line-badge";
            lineSpan.innerHTML = lineNumber;
            infoDiv.appendChild(lineSpan);
        }

        var platformSpan = document.createElement("span");
        platformSpan.className = "platform";
        platformSpan.innerHTML = "Plat " + platform;
        infoDiv.appendChild(platformSpan);

        item.appendChild(infoDiv);

        // Delay indicator
        if (isDelayed) {
            var delayDiv = document.createElement("div");
            delayDiv.className = "delay-badge";
            delayDiv.innerHTML = "+" + delayMinutes + " min";
            item.appendChild(delayDiv);
        }

        return item;
    }
});
