const App = {
    // --- CONFIGURATION ---
    CONFIG: {
        API_THROTTLE_MS: 1000,
        GEOJSON_URL: 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson'
    },

    // --- APPLICATION STATE ---
    map: null,
    locationsData: [],
    geocodeQueue: [],
    ambiguityChoices: [],
    ambiguityOriginalQuery: '',
    locatedCountryCodes: new Set(),
    isWikiLoaded: false,
    isoLookup: null, // Will hold the A2 to A3 lookup data

    // --- DOM ELEMENTS & STYLE VALUES ---
    elements: {},
    cssColors: {},

    // --- INITIALIZATION ---
    async init() {
        this.cacheDOMElementsAndStyles();
        // Load external data first
        await this.loadISOLookup();
        // Then initialize the rest of the app
        this.initMap();
        this.bindEvents();
    },

    cacheDOMElementsAndStyles() {
        this.elements = {
            locateBtn: document.getElementById('locateBtn'),
            locationsInput: document.getElementById('locations'),
            locationList: document.getElementById('location-list'),
            mapElement: document.getElementById('map'),
            fillCountriesCheckbox: document.getElementById('fillCountriesCheckbox'),
            locateBtnSpinner: document.querySelector('#locateBtn .spinner'),
            locateBtnText: document.querySelector('#locateBtn .btn-text'),
            ambiguityPopup: document.getElementById('ambiguity-popup-overlay'),
            ambiguityMsg: document.getElementById('ambiguity-popup-msg'),
            ambiguitySelect: document.getElementById('ambiguity-popup-select'),
            ambiguityOkBtn: document.getElementById('ambiguity-popup-ok'),
            ambiguitySkipBtn: document.getElementById('ambiguity-popup-skip'),
            wikiOpenBtn: document.getElementById('wiki-open-btn'),
            wikiSidebar: document.getElementById('wiki-sidebar'),
            wikiOverlay: document.getElementById('wiki-overlay'),
            wikiCloseBtn: document.getElementById('wiki-close-btn'),
            wikiTitle: document.getElementById('wiki-title'),
            wikiContent: document.getElementById('wiki-content'),
        };
        const rootStyle = getComputedStyle(document.documentElement);
        this.cssColors = {
            land: rootStyle.getPropertyValue('--land-fill').trim(),
            accent: rootStyle.getPropertyValue('--accent').trim()
        };
    },
    
    // NEW function to load the lookup data
    async loadISOLookup() {
        try {
            const response = await fetch('iso_a2_to_a3.json');
            if (!response.ok) throw new Error('Network response was not ok');
            this.isoLookup = await response.json();
        } catch (error) {
            console.error('Fatal Error: Could not load ISO country code lookup. Fill Countries feature will be disabled.', error);
            // Gracefully disable the feature if the file is missing
            this.elements.fillCountriesCheckbox.disabled = true;
            const label = this.elements.fillCountriesCheckbox.closest('label');
            if (label) {
                label.title = 'Country code data failed to load.';
                label.style.opacity = '0.5';
                label.style.cursor = 'not-allowed';
            }
        }
    },

    initMap() {
        this.map = new maplibregl.Map({
            container: this.elements.mapElement,
            style: { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#ddeeff' } }] },
            center: [0, 20],
            zoom: 1.5,
            attributionControl: false
        });
        this.map.on('load', () => {
            this.map.addSource('countries-source', { type: 'geojson', data: this.CONFIG.GEOJSON_URL });
            this.map.addLayer({ id: 'countries-fill-layer', type: 'fill', source: 'countries-source', paint: { 'fill-color': this.cssColors.land, 'fill-opacity': 1 } });
            this.map.addLayer({ id: 'countries-border-layer', type: 'line', source: 'countries-source', paint: { 'line-color': '#bbbbbb', 'line-width': 0.5 } });
        });
        this.map.addControl(new maplibregl.NavigationControl(), 'top-right');
        this.map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
    },

    bindEvents() {
        this.elements.locateBtn.onclick = () => this.startGeocoding();
        this.elements.ambiguityOkBtn.onclick = () => this.resolveAmbiguity();
        this.elements.ambiguitySkipBtn.onclick = () => this.skipAmbiguity();
        this.elements.fillCountriesCheckbox.addEventListener('change', () => this.updateCountryFills());
        this.elements.locationList.addEventListener('click', (e) => this.handleLocationListClick(e));
        this.elements.wikiOpenBtn.addEventListener('click', (e) => { e.preventDefault(); this.openWiki(); });
        this.elements.wikiCloseBtn.addEventListener('click', () => this.closeWiki());
        this.elements.wikiOverlay.addEventListener('click', () => this.closeWiki());
    },

    openWiki() {
        if (!this.isWikiLoaded) this.loadAndRenderWiki();
        this.elements.wikiOverlay.classList.remove('hidden');
        this.elements.wikiSidebar.classList.remove('hidden');
        requestAnimationFrame(() => { this.elements.wikiSidebar.classList.add('active'); });
    },

    closeWiki() {
        this.elements.wikiSidebar.classList.remove('active');
        this.elements.wikiOverlay.classList.add('hidden');
    },
    
    async loadAndRenderWiki() {
        try {
            const response = await fetch('wiki.json');
            if (!response.ok) throw new Error('Wiki file not found');
            const wikiData = await response.json();
            this.elements.wikiTitle.textContent = wikiData.title;
            this.elements.wikiContent.innerHTML = '';
            wikiData.sections.forEach(section => {
                const sectionTitle = document.createElement('h4');
                sectionTitle.textContent = section.title;
                this.elements.wikiContent.appendChild(sectionTitle);
                section.content.forEach(paragraphText => {
                    const p = document.createElement('p');
                    p.innerHTML = paragraphText;
                    this.elements.wikiContent.appendChild(p);
                });
            });
            this.isWikiLoaded = true;
        } catch (error) {
            console.error('Failed to load wiki:', error);
            this.elements.wikiContent.innerHTML = '<p>Error: Could not load the wiki documentation.</p>';
        }
    },

    // --- THIS FUNCTION NOW USES THE LOADED LOOKUP DATA ---
    placeLocation(result, originalQuery) {
        const markerId = Date.now();
        const labelText = result.display_name.split(',')[0];
        const coordinates = [parseFloat(result.lon), parseFloat(result.lat)];
        const countryCodeA2 = (result.address && result.address.country_code) ? result.address.country_code.toUpperCase() : null;
        const countryCodeA3 = this.isoLookup ? this.isoLookup[countryCodeA2] : null;

        const marker = new maplibregl.Marker().setLngLat(coordinates).addTo(this.map);
        const labelPopup = new maplibregl.Popup({ closeOnClick: false, closeButton: false, anchor: 'left', offset: 10 }).setLngLat(coordinates).setHTML(labelText).addTo(this.map);
        this.locationsData.push({ id: markerId, label: labelText, fullName: result.display_name, lon: coordinates[0], lat: coordinates[1], countryCode: countryCodeA3, mapMarker: marker, mapLabelPopup: labelPopup });
        if (countryCodeA3) this.locatedCountryCodes.add(countryCodeA3);
        this.renderListItem({ id: markerId, label: labelText });
        this.updateCountryFills();
        // this.map.flyTo({ center: coordinates, zoom: 9 }); // Auto-zoom is disabled
    },

    removeLocation(markerId) {
        const index = this.locationsData.findIndex(loc => loc.id === markerId);
        if (index === -1) return;
        const [locationData] = this.locationsData.splice(index, 1);
        locationData.mapMarker.remove();
        locationData.mapLabelPopup.remove();
        document.querySelector(`li[data-marker-id="${markerId}"]`).remove();
        this.recalculateLocatedCountries();
        this.updateCountryFills();
    },

    zoomToLocation(markerId) {
        const locationData = this.locationsData.find(loc => loc.id === markerId);
        if (!locationData) return;
        this.map.flyTo({ center: [locationData.lon, locationData.lat], zoom: 5 });
    },

    saveRename(li, markerId, newLabel) {
        li.classList.remove('is-editing');
        const locationData = this.locationsData.find(loc => loc.id === markerId);
        if (!locationData || !newLabel.trim()) return;
        locationData.label = newLabel.trim();
        li.querySelector('.location-name').textContent = locationData.label;
        locationData.mapLabelPopup.setHTML(locationData.label);
    },

    handleLocationListClick(event) {
        const button = event.target.closest('button');
        if (!button) return;
        const li = button.closest('li');
        const markerId = parseInt(li.dataset.markerId, 10);
        const unfoundQuery = li.dataset.query;
        if (button.classList.contains('remove-btn')) {
            if (markerId) this.removeLocation(markerId);
            else if (unfoundQuery) li.remove();
        } else if (button.classList.contains('zoom-btn')) {
            this.zoomToLocation(markerId);
        } else if (button.classList.contains('rename-btn')) {
            this.toggleRename(li, markerId);
        }
    },

    toggleRename(li, markerId) {
        const isEditing = li.classList.toggle('is-editing');
        const nameSpan = li.querySelector('.location-name');
        const input = li.querySelector('.location-edit-input');
        if (isEditing) {
            input.value = nameSpan.textContent;
            input.focus();
            input.select();
            const save = () => this.saveRename(li, markerId, input.value);
            const keydownHandler = (e) => {
                if (e.key === 'Enter') input.blur();
                else if (e.key === 'Escape') {
                    li.classList.remove('is-editing');
                    input.removeEventListener('blur', save);
                    input.removeEventListener('keydown', keydownHandler);
                }
            };
            input.addEventListener('blur', save, { once: true });
            input.addEventListener('keydown', keydownHandler);
        }
    },

    updateCountryFills() {
        if (!this.map.isStyleLoaded() || !this.map.getSource('countries-source')) return;
        if (this.elements.fillCountriesCheckbox.checked && this.locatedCountryCodes.size > 0) {
            const fillColorExpression = ['case', ['in', ['get', 'ADM0_A3'], ['literal', [...this.locatedCountryCodes]]], this.cssColors.accent, this.cssColors.land];
            this.map.setPaintProperty('countries-fill-layer', 'fill-color', fillColorExpression);
            this.map.setPaintProperty('countries-fill-layer', 'fill-opacity', 0.4);
        } else {
            this.map.setPaintProperty('countries-fill-layer', 'fill-color', this.cssColors.land);
            this.map.setPaintProperty('countries-fill-layer', 'fill-opacity', 1);
        }
    },

    recalculateLocatedCountries() {
        this.locatedCountryCodes.clear();
        this.locationsData.forEach(loc => {
            if (loc.countryCode) this.locatedCountryCodes.add(loc.countryCode);
        });
    },

    renderListItem(data) {
        const li = document.createElement('li');
        li.dataset.markerId = data.id;
        li.innerHTML = `
            <span class="location-name">${data.label}</span>
            <input type="text" class="location-edit-input" value="${data.label}" />
            <div class="location-controls">
                <button class="rename-btn" title="Rename">✏️</button>
                <button class="zoom-btn" title="Zoom To">🔍</button>
                <button class="remove-btn" title="Remove">🗑️</button>
            </div>
        `;
        this.elements.locationList.prepend(li);
    },

    renderUnfoundListItem(query, isError = false) {
        const li = document.createElement('li');
        li.classList.add('not-found');
        li.dataset.query = query;
        const message = isError ? 'Error searching' : 'Not found';
        li.innerHTML = `
            <span class="location-name">"${query}" - ${message}</span>
            <div class="location-controls">
                <button class="remove-btn" title="Remove">🗑️</button>
            </div>
        `;
        this.elements.locationList.prepend(li);
    },
    
    async geocode(query) {
    // A descriptive User-Agent is required by Nominatim's policy.
    // Replace with your app name/URL/email if you have one.
    const myAppUserAgent = 'Internal-LocatorTool/4.4-DataSplit (Internal Use; sporadic)';
    const url = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=5&q=${encodeURIComponent(query)}`;
    
    // Add the headers object to your fetch call
    const response = await fetch(url, {
        headers: {
            'User-Agent': myAppUserAgent
        }
    });

    if (!response.ok) throw new Error(`Geocoding error (${response.status})`);
    return response.json();
},

    startGeocoding() {
        const value = this.elements.locationsInput.value;
        this.geocodeQueue = value.split(/;|\n/).map(s => s.trim()).filter(Boolean);
        if (this.geocodeQueue.length > 0) {
            this.setLoadingState(true);
            this.processNextInGeocodeQueue();
            this.elements.locationsInput.value = '';
        }
    },
    
    processNextInGeocodeQueue() {
        if (this.geocodeQueue.length > 0) {
            const nextLocation = this.geocodeQueue.shift();
            setTimeout(() => this.handleLocationQuery(nextLocation), this.CONFIG.API_THROTTLE_MS);
        } else {
            this.setLoadingState(false);
        }
    },

    async handleLocationQuery(locationName) {
        try {
            const results = await this.geocode(locationName);
            const seenDisplayNames = new Set();
            const uniqueResults = results.filter(result => {
                if (seenDisplayNames.has(result.display_name)) {
                    return false;
                } else {
                    seenDisplayNames.add(result.display_name);
                    return true;
                }
            });
            if (uniqueResults.length === 0) {
                this.renderUnfoundListItem(locationName);
                this.processNextInGeocodeQueue();
                return;
            }
            const isClearlyBetter = uniqueResults.length > 1 && (uniqueResults[0].importance - uniqueResults[1].importance > 0.3);
            if (uniqueResults.length === 1 || isClearlyBetter) {
                this.placeLocation(uniqueResults[0], locationName);
                this.processNextInGeocodeQueue();
            } else {
                this.showAmbiguityPopup(uniqueResults, locationName);
            }
        } catch (error) {
            console.error(`Error for "${locationName}":`, error);
            this.renderUnfoundListItem(locationName, true);
            this.processNextInGeocodeQueue();
        }
    },
    
    setLoadingState(isLoading) {
        this.elements.locateBtn.disabled = isLoading;
        this.elements.locateBtnText.textContent = isLoading ? 'Adding...' : 'Add to Map';
        this.elements.locateBtnSpinner.classList.toggle('hidden', !isLoading);
    },

    showAmbiguityPopup(options, originalQuery) {
        this.ambiguityChoices = options;
        this.ambiguityOriginalQuery = originalQuery;
        this.elements.ambiguityMsg.textContent = `Multiple matches for "${originalQuery}":`;
        this.elements.ambiguitySelect.innerHTML = '';
        options.slice(0, 5).forEach((o, i) => this.elements.ambiguitySelect.add(new Option(o.display_name, String(i))));
        this.elements.ambiguityPopup.style.display = 'flex';
    },

    hideAmbiguityPopup() { this.elements.ambiguityPopup.style.display = 'none'; },

    resolveAmbiguity() {
        const selectedIndex = parseInt(this.elements.ambiguitySelect.value, 10);
        if (this.ambiguityChoices[selectedIndex]) {
            this.placeLocation(this.ambiguityChoices[selectedIndex], this.ambiguityOriginalQuery);
        }
        this.hideAmbiguityPopup();
        this.processNextInGeocodeQueue();
    },

    skipAmbiguity() {
        this.renderUnfoundListItem(this.ambiguityOriginalQuery);
        this.hideAmbiguityPopup();
        this.processNextInGeocodeQueue();
    }
};

// Start the application
App.init();