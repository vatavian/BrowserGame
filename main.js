(() => {
    const GEO_OPTIONS = {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 5000,
    };
    const TARGET_RADIUS = 35; // completion radius in meters
    const DEBUG_STEP_METERS = 12;

    // TODO: add user setting toggle
    let DBG = localStorage.getItem('DBG') === 'true' || (window.location.href.startsWith('http://localhost:') && localStorage.getItem('DBG') != 'false');
    function dbg(msg) { if (DBG || state.debugEnabled) console.log(msg); }

    // When editing OVERPASS_SERVER, also update index.html preconnect link
    // TODO: add user setting choice between known servers
    let OVERPASS_SERVER = localStorage.getItem('OVERPASS_SERVER') || "overpass.private.coffee"; // "overpass-api.de"

    const elements = {
        score: document.getElementById("scoreValue"),
        targetCount: document.getElementById("targetCount"),
        distanceToTarget: document.getElementById("distanceToTarget"),
        distanceTravelled: document.getElementById("distanceTravelled"),
        gpsAccuracy: document.getElementById("gpsAccuracy"),
        status: document.getElementById("statusMessage"),
        credits: document.getElementById("credits"),
        startButton: document.getElementById("startButton"),
        toggleDebug: document.getElementById("toggleDebug"),
        menuToggle: document.getElementById("menu-toggle"),
        cameraButton: document.getElementById("camera-button"),
    };

    const ZOOM_LEVEL = +localStorage.getItem("ZOOM_LEVEL") || 18;
    const VECTOR_CACHE_PREFIX = "vtile"; // Prefix for localStorage keys;
    const VECTOR_CACHE_TTL = 1000 * 60 * 60 * 24 * 30; // cache for 30 days

    const state = {
        map: null,
        playerMarker: null,
        accuracyCircle: null,
        watchId: null,
        hasFirstFix: false,
        lastFixTimestamp: null,
        playerPosition: null,
        displayPosition: null,
        accuracy: null,
        score: 0,
        distanceTravelled: 0,
        lastGamePosition: null,
        gameActive: false,
        target: null,
        debugEnabled: false,
        debugOffset: { lat: 0, lng: 0 },
        mapHasFollowed: false,
        userPanActive: false,
        roadLayerGroup: null,
        roadTileLayers: new Map(),
        pendingRoadTiles: new Set(),
        targetIntersections: [],
        visitedIntersections: [],
    };

    function init() {
        window.backdoor = state;
        initMap();

        elements.menuToggle.addEventListener("click", toggleMap);
        elements.startButton.addEventListener("click", handleStart);
        elements.toggleDebug.addEventListener("click", toggleDebugMode);
        elements.credits.innerText = "Map data © OpenStreetMap contributors, loaded via " + OVERPASS_SERVER + ", displayed with Leaflet";
        document.addEventListener("keydown", maybeHandleDebugNudge, { passive: false });
        requestLocationStream();
    }

    function initMap() {
        state.map = L.map("map", {
            zoomControl: false,
            attributionControl: false,
            preferCanvas: true,
            minZoom: ZOOM_LEVEL,
            maxZoom: ZOOM_LEVEL,
        }).setView([20, 0], ZOOM_LEVEL);

        state.roadLayerGroup = L.layerGroup().addTo(state.map);
        state.map.on("movestart", handleMapMoveStart);
        state.map.on("move", handleMapMove);
        state.map.on("moveend", handleMapMoveEnd);
        state.map.on("moveend", updateRoadTiles);
        state.map.on("zoomend", updateRoadTiles);
        L.control
            .attribution({ prefix: false })
            .addTo(state.map);

        updateRoadTiles();
    }

    function requestLocationStream() {
        if (!("geolocation" in navigator)) {
            showStatus("Geolocation is not supported by this browser.", "error");
            elements.startButton.disabled = true;
            return;
        }

        showStatus("Waiting for GPS lock...", "info");
        state.watchId = navigator.geolocation.watchPosition(onLocationUpdate, onLocationError, GEO_OPTIONS);
    }

    function onLocationUpdate(position) {
        state.lastFixTimestamp = Date.now();
        state.playerPosition = {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
        };
        state.accuracy = position.coords.accuracy;
        state.hasFirstFix = true;

        if (!state.gameActive) {
            showStatus("GPS lock acquired. Ready when you are!", "success");
        }

        if (!state.playerMarker) {
            createPlayerMarker(state.playerPosition);
            state.map.setView(state.playerPosition, ZOOM_LEVEL);
            state.mapHasFollowed = true;
            updateRoadTiles();
        }

        updateDisplayedPosition();
        updateAccuracyVisual();
        updateHudAccuracy();
        updateTravelledDistance();
        updateTargetTracking();
    }

    function onLocationError(error) {
        if (error.code === error.PERMISSION_DENIED) {
            showStatus("Location permission denied. Enable it to play.", "error");
            elements.startButton.disabled = true;
            return;
        }
        showStatus(`Location error: ${error.message}`, "error");
    }

    function toggleMap() {
        document.querySelector('main').classList.toggle('show-map'); 
    }
    function handleStart() {
        if (!state.hasFirstFix) {
            showStatus("Still waiting for your location. Try again in a moment.", "error");
            return;
        }
        toggleMap();
        resetGameState();
        showStatus("Sprint started! Chase the glowing orb nearby.", "success");
        spawnTargetsAtIntersections();
    }

    function resetGameState() {
        state.gameActive = true;
        state.score = 0;
        state.distanceTravelled = 0;
        state.lastGamePosition = state.displayPosition;
        elements.score.textContent = "0";
        elements.targetCount.textContent = "0";
        elements.distanceTravelled.textContent = formatDistance(0);
        removeTargets();
    }

    function createPlayerMarker(position) {
        const playerIcon = L.divIcon({
            className: "player-icon",
            html: '<div style="width:18px;height:18px;border-radius:50%;background:#51cf66;box-shadow:0 0 18px rgba(81,207,102,0.7);"></div>',
            iconSize: [18, 18],
            iconAnchor: [9, 9],
        });
        state.playerMarker = L.marker(position, { icon: playerIcon }).addTo(state.map);

        state.accuracyCircle = L.circle(position, {
            radius: state.accuracy || 20,
            color: "#51cf66",
            weight: 1,
            opacity: 0.3,
            fillColor: "#51cf66",
            fillOpacity: 0.06,
        }).addTo(state.map);
    }

    function handleMapMoveStart(event) {
        if (!state.debugEnabled || !event) {
            state.userPanActive = false;
            return;
        }
        state.userPanActive = true;
        syncDebugOffsetToMapCenter();
    }

    function handleMapMove() {
        if (!state.debugEnabled || !state.userPanActive) {
            return;
        }
        syncDebugOffsetToMapCenter();
    }

    function handleMapMoveEnd() {
        if (!state.debugEnabled || !state.userPanActive) {
            state.userPanActive = false;
            return;
        }
        state.userPanActive = false;
        syncDebugOffsetToMapCenter();
    }

    function latLngToTile(lat, lng, zoom) {
        const scale = 1 << zoom;
        const clampedLat = Math.min(85.05112878, Math.max(-85.05112878, lat));
        const clampedLng = Math.min(180, Math.max(-180, lng));
        const xFloat = ((clampedLng + 180) / 360) * scale;
        const latRad = (clampedLat * Math.PI) / 180;
        const yFloat =
            ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * scale;
        const x = Math.min(scale - 1, Math.max(0, Math.floor(xFloat)));
        const y = Math.min(scale - 1, Math.max(0, Math.floor(yFloat)));
        return { x, y };
    }

    function tileToBounds(x, y, zoom) {
        const scale = 1 << zoom;
        const west = (x / scale) * 360 - 180;
        const east = ((x + 1) / scale) * 360 - 180;
        const northRad = Math.atan(Math.sinh(Math.PI - (2 * Math.PI * y) / scale));
        const southRad = Math.atan(Math.sinh(Math.PI - (2 * Math.PI * (y + 1)) / scale));
        return {
            south: (southRad * 180) / Math.PI,
            west,
            north: (northRad * 180) / Math.PI,
            east,
        };
    }

    function makeTileCacheKey(x, y) {
        return `${VECTOR_CACHE_PREFIX}_${ZOOM_LEVEL}_${x}_${y}`;
    }

    function readTileFromCache(key) {
        let raw;
        try {
            raw = localStorage.getItem(key);
        } catch (error) {
            console.warn("LocalStorage unavailable for vector cache", error);
            return null;
        }
        if (!raw) {
            return null;
        }
        try {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== "object") {
                return null;
            }
            if (Date.now() - parsed.timestamp > VECTOR_CACHE_TTL) {
                try {
                    localStorage.removeItem(key);
                } catch (error) {
                    console.warn("Failed to clear expired vector tile", error);
                }
                return null;
            }
            return parsed.data;
        } catch (error) {
            console.warn("Failed to parse cached vector tile", error);
            try {
                localStorage.removeItem(key);
            } catch (removeError) {
                console.warn("Failed to remove corrupt vector tile cache entry", removeError);
            }
            return null;
        }
    }

    function writeTileToCache(key, data) {
        try {
            const payload = JSON.stringify({ timestamp: Date.now(), data });
            localStorage.setItem(key, payload);
        } catch (error) {
            console.warn("Failed to cache vector tile", key, error);
        }
    }

    function overpassToGeoJSON(elements) {
        const features = [];
        for (const element of elements) {
            if (element.type !== "way" || !Array.isArray(element.geometry)) {
                continue;
            }
            const coordinates = element.geometry.map((point) => [point.lon, point.lat]);
            if (coordinates.length < 2) {
                continue;
            }
            features.push({
                type: "Feature",
                id: `way/${element.id}`,
                properties: {
                    highway: element.tags?.highway || null,
                    name: element.tags?.name || null,
                },
                geometry: {
                    type: "LineString",
                    coordinates,
                },
            });
        }
        return { type: "FeatureCollection", features };
    }

    function styleForRoad(feature) {
        const highway = feature.properties?.highway || "";
        const palette = {
            motorway: { color: "#ff6b6b", weight: 4 },
            trunk: { color: "#f06595", weight: 3.5 },
            primary: { color: "#fab005", weight: 3.2 },
            secondary: { color: "#fcc419", weight: 3 },
            tertiary: { color: "#ffd43b", weight: 2.6 },
            residential: { color: "#adb5bd", weight: 2.2 },
            living_street: { color: "#ced4da", weight: 2 },
            service: { color: "#dee2e6", weight: 1.8 },
            footway: { color: "#82c91e", weight: 1.4 },
            cycleway: { color: "#51cf66", weight: 1.4 },
            path: { color: "#69db7c", weight: 1.4 },
        };
        const defaultStyle = { color: "#4c6ef5", weight: 2.2 };
        const style = palette[highway] || defaultStyle;
        return {
            color: style.color,
            weight: style.weight,
            opacity: 0.85,
            lineCap: "round",
            lineJoin: "round",
        };
    }

    async function fetchTileData(x, y) {
        dbg(`Fetching data for tile ${x},${y} at zoom ${ZOOM_LEVEL}`);
        const bounds = tileToBounds(x, y, ZOOM_LEVEL);
        const query = `\n            [out:json][timeout:25];\n            (\n              way[\"highway\"](${bounds.south},${bounds.west},${bounds.north},${bounds.east});\n            );\n            out geom;\n        `;
        const body = new URLSearchParams({ data: query });
        const response = await fetch("https://" + OVERPASS_SERVER + "/api/interpreter", {
            method: "POST",
            body,
            headers: {
                "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            },
        });
        if (!response.ok) {
            throw new Error(`Overpass API request for tile ${x},${y} failed with ${response.status}`);
        }
        try {
            const payload = await response.json();
            return overpassToGeoJSON(payload.elements || []);
        } catch (error) {
            console.log("Response text:", await response.text());
            throw new Error(`Failed to parse Overpass API response for tile ${x},${y}: ${error.message}`);
        }
    }

    function addRoadLayerForTile(key, geojson) {
        if (!state.roadLayerGroup) {
            return;
        }
        const layer = L.geoJSON(geojson, { style: styleForRoad });
        layer.addTo(state.roadLayerGroup);
        state.roadTileLayers.set(key, layer);
    }

    function removeStaleTiles(neededKeys) {
        for (const [key, layer] of state.roadTileLayers.entries()) {
            if (!neededKeys.has(key)) {
                state.roadLayerGroup.removeLayer(layer);
                state.roadTileLayers.delete(key);
            }
        }
    }

    function updateRoadTiles() {
        if (!state.map) {
            return;
        }
        const bounds = state.map.getBounds();
        const northWest = latLngToTile(bounds.getNorth(), bounds.getWest(), ZOOM_LEVEL);
        const southEast = latLngToTile(bounds.getSouth(), bounds.getEast(), ZOOM_LEVEL);
        const neededKeys = new Set();
        for (let x = northWest.x; x <= southEast.x; x += 1) {
            for (let y = northWest.y; y <= southEast.y; y += 1) {
                const key = makeTileCacheKey(x, y); // `${x}:${y}`;
                neededKeys.add(key);
                if (state.roadTileLayers.has(key) || state.pendingRoadTiles.has(key)) {
                    continue;
                }

                const cached = readTileFromCache(key);
                if (cached) {
                    dbg(`Found cached data for tile ${key}`);
                    addRoadLayerForTile(key, cached);
                    continue;
                }

                state.pendingRoadTiles.add(key);
                fetchTileData(x, y)
                    .then((geojson) => {
                        dbg(`Fetched data for tile ${key}: ${geojson}`);
                        addRoadLayerForTile(key, geojson);
                        writeTileToCache(key, geojson);
                    })
                    .catch((error) => {
                        console.error("Failed to load data for", key, error);
                    })
                    .finally(() => {
                        state.pendingRoadTiles.delete(key);
                    });
            }
        }
        removeStaleTiles(neededKeys);
    }

    function syncDebugOffsetToMapCenter() {
        if (!state.playerPosition || !state.map) {
            return;
        }
        const center = state.map.getCenter();
        state.debugOffset = {
            lat: center.lat - state.playerPosition.lat,
            lng: center.lng - state.playerPosition.lng,
        };
        state.mapHasFollowed = true;
        updateDisplayedPosition();
        updateAccuracyVisual();
        updateTravelledDistance();
        updateTargetTracking();
    }

    function updateDisplayedPosition() {
        if (!state.playerPosition) {
            return;
        }
        const adjusted = applyDebugOffset(state.playerPosition);
        state.displayPosition = adjusted;

        if (state.playerMarker) {
            state.playerMarker.setLatLng(adjusted);
//            const heading = state.playerMarker.options.rotationAngle || 0;
//            state.playerMarker.setRotationAngle(heading);
            const boundsFraction = 0.9;
            const curBounds = state.map.getBounds();
            const latDist = (curBounds.getNorth() - curBounds.getSouth()) * boundsFraction;
            const lngDist = (curBounds.getEast() - curBounds.getWest()) * boundsFraction;
            const newMaxBounds = L.latLngBounds(
                L.latLng(adjusted.lat - latDist, adjusted.lng - lngDist),
                L.latLng(adjusted.lat + latDist, adjusted.lng + lngDist));
            // dbg("bounds", curBounds.toBBoxString(), "+", boundsFraction, "=", newMaxBounds.toBBoxString());
            state.map.setMaxBounds(newMaxBounds);
            if (state.userPanActive) {
                state.map.panInsideBounds(newMaxBounds, { animate: false });
            } else {
                const center = state.map.getCenter();
                if (!state.mapHasFollowed) {
                    state.map.panTo(adjusted, { animate: true, duration: 0.35 });
                    state.mapHasFollowed = true;
                }
            }
        }
    }

    function applyDebugOffset(position) {
        if (!state.debugEnabled) {
            return { ...position };
        }
        return {
            lat: position.lat + state.debugOffset.lat,
            lng: position.lng + state.debugOffset.lng,
        };
    }

    function updateAccuracyVisual() {
        if (!state.accuracyCircle || !state.displayPosition) {
            return;
        }
        state.accuracyCircle.setLatLng(state.displayPosition);
        state.accuracyCircle.setRadius(Math.max(state.accuracy || 20, 10));
    }

    function updateHudAccuracy() {
        elements.gpsAccuracy.textContent = formatDistance(state.accuracy);
    }

    // For each vector tile, find intersections between roads.
    // Returns array of [lon, lat] points.
    // Duplicate points are not added to return array.
    function findIntersections() {
        const intersections = [];
        const seen = new Set();
        if (!state.roadTileLayers) return intersections;
        state.roadTileLayers.forEach((tile, key) => {
            tile.getLayers()?.forEach(({feature: feature1}) => {
                const c1 = feature1?.geometry?.coordinates;
                if (c1) tile.getLayers()?.forEach(({feature: feature2}) => {
                    if (feature2?.id > feature1.id) { // avoid double-checking pairs
                        intersect = feature2.geometry?.coordinates?.find(c2c =>
                            c1.find(c1c => c1c[0] === c2c[0] && c1c[1] === c2c[1]));
                        if (intersect) {
                            const key = intersect[0].toFixed(6) + "," + intersect[1].toFixed(6);
                            if (!seen.has(key)) {
                                seen.add(key);
                                intersections.push(intersect); //{point: intersect, roads: [feature1, feature2]});
                            }
                        }
                    }
                });
            });
        });
        return intersections;
    }

    function spawnTargetsAtIntersections() {
        if (!state.displayPosition) {
            return;
        }
        removeTargets();
        const now = Date.now();
        for (const intersection of findIntersections()) {
            const latlng = { lat: intersection[1], lng: intersection[0] };
            const marker = L.circleMarker(latlng, {
                radius: 12,
                color: "#f6a821",
                fillColor: "#ffce54",
                weight: 3,
                fillOpacity: 0.9,
                className: "target-marker",
            }).addTo(state.map);
            state.targetIntersections.push({
                position: intersection,
                radius: TARGET_RADIUS,
                spawnedAt: Date.now(),
                marker: marker,
            });
        };
    }

    function removeTargets() {
        elements.distanceToTarget.textContent = "--";
        state.targetIntersections.forEach(({marker}) => state.map.removeLayer(marker));
        state.targetIntersections = [];
    }

    function updateTravelledDistance() {
        if (!state.displayPosition) {
            return;
        }
        if (!state.lastGamePosition) {
            state.lastGamePosition = state.displayPosition;
            return;
        }
        const segment = computeDistanceMeters(state.lastGamePosition, state.displayPosition);
        if (state.gameActive && segment > 0.4) {
            state.distanceTravelled += segment;
            elements.distanceTravelled.textContent = formatDistance(state.distanceTravelled);
        }
        state.lastGamePosition = state.displayPosition;
    }

    function updateTargetTracking() {
        if (state.gameActive && state.displayPosition && state.targetIntersections.length > 0) {
            let closest = null;
            for (const intersection of state.targetIntersections) {
                const distance = computeDistanceMeters(state.displayPosition, {lat: intersection.position[1], lng: intersection.position[0]});
                if (distance <= intersection.radius) {
                    state.visitedIntersections.push(intersection);
                    state.map.removeLayer(intersection.marker);
                    intersection.marker = L.circleMarker({ lat: intersection.position[1], lng: intersection.position[0] }, {
                        radius: 12,
                        color: "#17c04cff",
                        fillColor: "#80e791ff",
                        weight: 3,
                        fillOpacity: 0.9,
                        className: "target-marker",
                    }).addTo(state.map);

                    state.targetIntersections = state.targetIntersections.filter(i => i !== intersection);
                    state.score += 10;
                    elements.score.textContent = state.score.toString();
                    elements.targetCount.textContent = (state.visitedIntersections.length).toString();
                    showStatus("Intersection reached!", "success");
                    return;
                } else if (!closest || distance < closest) {
                    closest = distance;
                }
            }
            elements.distanceToTarget.textContent = formatDistance(closest);
        }
    }

    function toggleDebugMode() {
        state.debugEnabled = !state.debugEnabled;
        elements.toggleDebug.setAttribute("aria-pressed", String(state.debugEnabled));
        document.body.classList.toggle("debug-enabled", state.debugEnabled);
        if (!state.debugEnabled) {
            state.debugOffset = { lat: 0, lng: 0 };
            state.userPanActive = false;
            updateDisplayedPosition();
            updateAccuracyVisual();
            updateTargetTracking();
            showStatus("Debug mode disabled.", "info");
            elements.toggleDebug.textContent = "Enable Debug Mode";
        } else {
            state.userPanActive = false;
            elements.toggleDebug.textContent = "Disable Debug Mode";
            showStatus("Debug mode on. Pan the map or use arrow keys to move your avatar.", "info");
        }
        toggleMap();
    }
    function maybeHandleDebugNudge(event) {
        if (!state.debugEnabled) {
            return;
        }
        const { key } = event;
        if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(key)) {
            return;
        }
        event.preventDefault();
        if (!state.playerPosition) {
            return;
        }

        const stepMeters = event.shiftKey ? DEBUG_STEP_METERS * 4 : DEBUG_STEP_METERS;
        const latFactor = stepMeters / 111111;
        const effectiveLat = state.playerPosition.lat + state.debugOffset.lat;
        const lngFactor = stepMeters / (111111 * Math.cos((effectiveLat * Math.PI) / 180));

        switch (key) {
            case "ArrowUp":
                state.debugOffset.lat += latFactor;
                break;
            case "ArrowDown":
                state.debugOffset.lat -= latFactor;
                break;
            case "ArrowRight":
                state.debugOffset.lng += lngFactor;
                break;
            case "ArrowLeft":
                state.debugOffset.lng -= lngFactor;
                break;
        }

        state.mapHasFollowed = false;
        updateDisplayedPosition();
        updateAccuracyVisual();
        updateTravelledDistance();
        updateTargetTracking();
    }

    function projectPoint(origin, bearingDegrees, distanceMeters) {
        const R = 6371000;
        const bearing = (bearingDegrees * Math.PI) / 180;
        const lat1 = (origin.lat * Math.PI) / 180;
        const lng1 = (origin.lng * Math.PI) / 180;
        const angularDistance = distanceMeters / R;

        const lat2 = Math.asin(
            Math.sin(lat1) * Math.cos(angularDistance) +
                Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing)
        );
        const lng2 =
            lng1 +
            Math.atan2(
                Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
                Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2)
            );

        return {
            lat: (lat2 * 180) / Math.PI,
            lng: ((lng2 * 180) / Math.PI + 540) % 360 - 180,
        };
    }

    function computeDistanceMeters(a, b) {
        const R = 6371000;
        const dLat = toRadians(b.lat - a.lat);
        const dLng = toRadians(b.lng - a.lng);
        const lat1 = toRadians(a.lat);
        const lat2 = toRadians(b.lat);
        const sinDLat = Math.sin(dLat / 2);
        const sinDLng = Math.sin(dLng / 2);
        const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
    }

    function randomBetween(min, max) {
        return Math.random() * (max - min) + min;
    }

    function toRadians(value) {
        return (value * Math.PI) / 180;
    }

    function formatDistance(distanceMeters) {
        if ((typeof distanceMeters !== "number") || Number.isNaN(distanceMeters)) {
            return "--";
        }
        if (distanceMeters >= 1000) {
            return `${(distanceMeters / 1000).toFixed(2)} km`;
        }
        return `${Math.round(distanceMeters)} m`;
    }

    function showStatus(message, tone = "info") {
        elements.status.textContent = message;
        elements.status.dataset.status = tone;
    }
    let stream = null;
    let video = null;
    let canvas = null;
    let imgElement = null;

    elements.cameraButton.addEventListener('click', () => {
        if (!stream) {
            startCamera();
        }
        else {
            takePhoto();
        }
    });

    async function startCamera() {
        try {
            stream = await navigator.mediaDevices.getUserMedia({audio: false, video: {
                facingMode: "environment",
                width: 150,
                height: 150,
            }});
            video = document.createElement('video');
            video.classList.add('cam');
            video.autoplay = true;
            document.body.appendChild(video);
            video.srcObject = stream;

        } catch (err) {
            console.error("Error accessing camera:", err);
            showStatus(`Camera access denied: ${err.message}`, 'error');
        }
    }

    function takePhoto() {
        if (stream && video) {
            canvas = document.createElement('canvas');
            document.body.appendChild(canvas);
            canvas.style.display = 'none';
            const context = canvas.getContext('2d');
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            context.drawImage(video, 0, 0, video.videoWidth, video.videoHeight);
            const imageDataUrl = canvas.toDataURL('image/png');

            imgElement = document.createElement('img');
            imgElement.classList.add('cam');
            document.body.appendChild(imgElement);

            imgElement.src = imageDataUrl;

            stream.getTracks().forEach(track => track.stop());
            video.remove();
            canvas.remove();
            stream = null;
        }
    }

    init();
})();
