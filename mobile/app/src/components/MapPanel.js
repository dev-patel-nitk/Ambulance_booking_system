import { createElement, useEffect, useMemo, useRef } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { colors, radius } from '../lib/theme';
import { MAP_CONFIG } from '../lib/config';

/**
 * Enhanced MapPanel with:
 * 1. MapTiler Raster Tiles API (key: 6mLLgOMyLQp0DFy6CtAC) with streets, dark, and satellite styles + OSM fallback.
 * 2. Nominatim Geocoding & Reverse Geocoding (interactive tap-to-reverse-geocode with address popup & map search).
 * 3. OSRM (Open Source Routing Machine) driving route rendering with distance/ETA HUD and auto-routing.
 *
 * Runs seamlessly on both Native (react-native-webview) and Web (iframe fallback).
 */
export default function MapPanel(props) {
  return Platform.OS === 'web' ? <WebMap {...props} /> : <NativeMap {...props} />;
}

function NativeMap({
  markers = [],
  route = [],
  height = 260,
  onPick,
  zoom = 14,
  mapStyle = 'streets',
  maptilerKey = MAP_CONFIG.maptilerKey,
  autoRoute = false,
  showSearch = false,
  showStyleToggle = true,
  showRouteInfo = true,
}) {
  const webRef = useRef(null);

  const html = useMemo(
    () =>
      buildHtml({
        zoom,
        pickable: Boolean(onPick),
        maptilerKey,
        defaultStyle: mapStyle,
        showSearch,
        showStyleToggle,
        showRouteInfo,
      }),
    [zoom, Boolean(onPick), maptilerKey, mapStyle, showSearch, showStyleToggle, showRouteInfo]
  );

  const payload = useMemo(
    () =>
      JSON.stringify({
        markers: markers.filter((m) => m && m.latitude != null),
        route: route || [],
        autoRoute: Boolean(autoRoute),
        mapStyle,
      }),
    [markers, route, autoRoute, mapStyle]
  );

  // Injected JavaScript updates map state smoothly without destroying the DOM/Leaflet instance
  const inject = `window.applyState(${payload}); true;`;

  // Real-time tracking: push state updates to the WebView as ambulance moves
  useEffect(() => {
    webRef.current?.injectJavaScript(`window.applyState(${payload}); true;`);
  }, [payload]);

  return (
    <View style={[styles.wrap, { height }]}>
      <WebView
        ref={webRef}
        originWhitelist={['*']}
        source={{ html }}
        style={styles.web}
        injectedJavaScript={inject}
        onMessage={(e) => {
          try {
            const msg = JSON.parse(e.nativeEvent.data);
            if (msg.type === 'pick' && onPick) {
              onPick(msg.lat, msg.lng, { address: msg.address, pincode: msg.pincode });
            }
            if (msg.type === 'ready') webRef.current?.injectJavaScript(inject);
          } catch {
            // ignore malformed bridge messages
          }
        }}
        javaScriptEnabled
        domStorageEnabled
        scrollEnabled={false}
        androidLayerType="hardware"
      />
    </View>
  );
}

function WebMap({
  markers = [],
  route = [],
  height = 260,
  onPick,
  zoom = 14,
  mapStyle = 'streets',
  maptilerKey = MAP_CONFIG.maptilerKey,
  autoRoute = false,
  showSearch = false,
  showStyleToggle = true,
  showRouteInfo = true,
}) {
  const frameRef = useRef(null);

  const html = useMemo(
    () =>
      buildHtml({
        zoom,
        pickable: Boolean(onPick),
        maptilerKey,
        defaultStyle: mapStyle,
        showSearch,
        showStyleToggle,
        showRouteInfo,
      }),
    [zoom, Boolean(onPick), maptilerKey, mapStyle, showSearch, showStyleToggle, showRouteInfo]
  );

  const payload = useMemo(
    () =>
      JSON.stringify({
        markers: markers.filter((m) => m && m.latitude != null),
        route: route || [],
        autoRoute: Boolean(autoRoute),
        mapStyle,
      }),
    [markers, route, autoRoute, mapStyle]
  );

  useEffect(() => {
    const win = frameRef.current?.contentWindow;
    if (win?.applyState) win.applyState(JSON.parse(payload));
  }, [payload]);

  useEffect(() => {
    if (!onPick) return undefined;
    const onMessage = (e) => {
      if (e.source !== frameRef.current?.contentWindow) return;
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'pick') {
          onPick(msg.lat, msg.lng, { address: msg.address, pincode: msg.pincode });
        }
        if (msg.type === 'ready') frameRef.current?.contentWindow?.applyState(JSON.parse(payload));
      } catch {
        // ignore non-bridge messages
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onPick, payload]);

  return (
    <View style={[styles.wrap, { height }]}>
      {createElement('iframe', {
        ref: frameRef,
        srcDoc: html,
        onLoad: () => frameRef.current?.contentWindow?.applyState?.(JSON.parse(payload)),
        style: { width: '100%', height: '100%', border: 0, background: '#0b1119' },
        title: 'map',
      })}
    </View>
  );
}

function buildHtml({
  zoom = 14,
  pickable = false,
  maptilerKey = '6mLLgOMyLQp0DFy6CtAC',
  defaultStyle = 'streets',
  showSearch = false,
  showStyleToggle = true,
  showRouteInfo = true,
}) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
  * { box-sizing: border-box; }
  html, body, #map { height: 100%; margin: 0; padding: 0; background: #0b1119; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .leaflet-control-attribution { font-size: 9px; background: rgba(11, 17, 25, 0.85) !important; color: #94a3b8 !important; padding: 2px 6px; border-radius: 4px; }
  .leaflet-control-attribution a { color: #38bdf8 !important; text-decoration: none; }

  /* Map Controls Overlay */
  .map-overlay-container {
    position: absolute;
    z-index: 1000;
    pointer-events: none;
  }
  .clickable { pointer-events: auto; }

  /* Compact Style Switcher (no overlap) */
  .style-cycle-btn {
    top: 8px;
    right: 8px;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    background: rgba(15, 23, 42, 0.9);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 14px;
    padding: 4px 9px;
    color: #f8fafc;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    box-shadow: 0 4px 10px rgba(0,0,0,0.35);
    z-index: 1000;
    white-space: nowrap;
  }
  .style-cycle-btn:active {
    transform: scale(0.96);
    background: rgba(30, 41, 59, 0.95);
  }

  /* OSRM Route HUD */
  .route-hud {
    bottom: 12px;
    left: 12px;
    background: rgba(15, 23, 42, 0.9);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    border: 1px solid rgba(56, 189, 248, 0.3);
    color: #f8fafc;
    border-radius: 8px;
    padding: 6px 10px;
    font-size: 11px;
    box-shadow: 0 4px 14px rgba(0,0,0,0.4);
    display: none;
    align-items: center;
    gap: 8px;
  }
  .route-hud .route-badge {
    background: #0284c7;
    color: #fff;
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    padding: 2px 6px;
    border-radius: 4px;
    letter-spacing: 0.5px;
  }
  .route-hud .route-metrics { font-weight: 600; }
  .route-hud .route-metrics span { color: #38bdf8; font-weight: 700; }

  /* Nominatim Search Bar */
  .search-container {
    top: 8px;
    left: 8px;
    right: 105px;
    max-width: 250px;
    z-index: 1000;
  }
  .search-input-wrap {
    display: flex;
    align-items: center;
    background: rgba(15, 23, 42, 0.92);
    backdrop-filter: blur(8px);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 8px;
    overflow: hidden;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
  }
  .search-input {
    flex: 1;
    background: transparent;
    border: none;
    color: #f8fafc;
    font-size: 12px;
    padding: 7px 10px;
    outline: none;
  }
  .search-input::placeholder { color: #64748b; }
  .search-btn {
    background: #2563eb;
    border: none;
    color: #ffffff;
    font-size: 11px;
    padding: 7px 10px;
    cursor: pointer;
    font-weight: 600;
  }
  .search-dropdown {
    position: absolute;
    top: 36px;
    left: 0;
    right: 0;
    background: rgba(15, 23, 42, 0.96);
    border: 1px solid rgba(255,255,255,0.15);
    border-radius: 8px;
    margin-top: 4px;
    max-height: 140px;
    overflow-y: auto;
    display: none;
    box-shadow: 0 8px 16px rgba(0,0,0,0.4);
  }
  .search-item {
    padding: 6px 10px;
    font-size: 11px;
    color: #cbd5e1;
    cursor: pointer;
    border-bottom: 1px solid rgba(255,255,255,0.06);
    line-height: 1.3;
  }
  .search-item:hover { background: rgba(37, 99, 235, 0.25); color: #fff; }

  /* Pin & Icon Markers */
  .custom-pin-marker {
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
  }
  .pin-icon {
    font-size: 20px;
    filter: drop-shadow(0 2px 4px rgba(0,0,0,0.5));
  }
  .pin-pulse {
    position: absolute;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: rgba(239, 68, 68, 0.35);
    border: 2px solid #ef4444;
    animation: marker-pulse 1.8s infinite;
  }
  .ambulance-pulse {
    position: absolute;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: rgba(34, 197, 94, 0.3);
    border: 2px solid #22c55e;
    animation: marker-pulse 1.6s infinite;
  }
  @keyframes marker-pulse {
    0% { transform: scale(0.6); opacity: 1; }
    100% { transform: scale(1.6); opacity: 0; }
  }

  /* Custom Popup Styling */
  .leaflet-popup-content-wrapper {
    background: rgba(15, 23, 42, 0.96) !important;
    backdrop-filter: blur(8px);
    border: 1px solid rgba(255, 255, 255, 0.15) !important;
    color: #f8fafc !important;
    border-radius: 8px !important;
    box-shadow: 0 8px 20px rgba(0,0,0,0.4) !important;
    padding: 0 !important;
  }
  .leaflet-popup-tip { background: rgba(15, 23, 42, 0.96) !important; }
  .leaflet-popup-content { margin: 8px 12px !important; line-height: 1.4 !important; font-size: 11px !important; }
  .popup-title { font-weight: 700; color: #38bdf8; margin-bottom: 2px; }
  .popup-subtitle { color: #cbd5e1; font-size: 10px; max-width: 200px; word-break: break-word; }
</style>
</head>
<body>
<div id="map"></div>

${showStyleToggle ? `
<button id="style-cycle-btn" class="map-overlay-container style-cycle-btn clickable" onclick="cycleMapStyle()" title="Map Style">
  <span id="style-icon">🗺️</span>
  <span id="style-text">Streets</span>
</button>` : ''}

${showSearch ? `
<div class="map-overlay-container search-container clickable">
  <div class="search-input-wrap">
    <input id="nominatim-query" class="search-input" placeholder="🔍 Search place/landmark..." onkeydown="if(event.key==='Enter')searchNominatim();" />
    <button class="search-btn" onclick="searchNominatim()">Go</button>
  </div>
  <div id="search-dropdown" class="search-dropdown"></div>
</div>` : ''}

${showRouteInfo ? `
<div id="route-hud" class="map-overlay-container route-hud clickable">
  <span class="route-badge">OSRM</span>
  <span class="route-metrics" id="route-hud-text">Calculating route…</span>
</div>` : ''}

<script>
  var MAPTILER_KEY = '${maptilerKey}';
  var currentStyle = '${defaultStyle || 'streets'}';
  var tileLayer = null;
  var isRetina = window.devicePixelRatio > 1;

  var map = L.map('map', {
    zoomControl: false,
    attributionControl: true
  }).setView([13.0104, 74.7942], ${zoom});

  // ------------------------------------------------------------- MAPTILER TILES
  function getMapTilerUrl(style) {
    if (style === 'dark') {
      return 'https://api.maptiler.com/maps/dataviz-dark/{z}/{x}/{y}' + (isRetina ? '@2x' : '') + '.png?key=' + MAPTILER_KEY;
    }
    if (style === 'satellite') {
      return 'https://api.maptiler.com/maps/satellite/{z}/{x}/{y}' + (isRetina ? '@2x' : '') + '.jpg?key=' + MAPTILER_KEY;
    }
    return 'https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}' + (isRetina ? '@2x' : '') + '.png?key=' + MAPTILER_KEY;
  }

  function setTileLayer(style) {
    if (tileLayer) map.removeLayer(tileLayer);
    currentStyle = style;

    tileLayer = L.tileLayer(getMapTilerUrl(style), {
      tileSize: 512,
      zoomOffset: -1,
      minZoom: 1,
      maxZoom: 20,
      crossOrigin: true,
      attribution: '&copy; <a href="https://www.maptiler.com/" target="_blank">MapTiler</a> &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>'
    });

    // Fallback if MapTiler is unreachable or offline
    tileLayer.on('tileerror', function() {
      if (!window._osmFallback) {
        window._osmFallback = true;
        map.removeLayer(tileLayer);
        tileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        }).addTo(map);
      }
    });

    tileLayer.addTo(map);
    updateStyleButton(style);
  }

  var STYLES = [
    { id: 'streets', label: 'Streets', icon: '🗺️' },
    { id: 'dark', label: 'Dark', icon: '🌙' },
    { id: 'satellite', label: 'Satellite', icon: '🛰️' }
  ];

  window.cycleMapStyle = function() {
    var idx = STYLES.findIndex(function(s) { return s.id === currentStyle; });
    var next = STYLES[(idx + 1) % STYLES.length];
    setTileLayer(next.id);
  };

  function updateStyleButton(style) {
    var cur = STYLES.find(function(s) { return s.id === style; }) || STYLES[0];
    var iconEl = document.getElementById('style-icon');
    var textEl = document.getElementById('style-text');
    if (iconEl) iconEl.innerText = cur.icon;
    if (textEl) textEl.innerText = cur.label;
  }

  window.switchMapStyle = function(style) {
    setTileLayer(style);
  };

  setTileLayer(currentStyle);

  var layer = L.layerGroup().addTo(map);
  var routeLayer = L.layerGroup().addTo(map);
  var lastSignature = '';
  var currentPickMarker = null;

  function post(obj) {
    var payload = JSON.stringify(obj);
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(payload);
    else if (window.parent !== window) window.parent.postMessage(payload, '*');
  }

  // -------------------------------------------------------- NOMINATIM REVERSE
  function reverseGeocodeNominatim(lat, lng, markerToUpdate) {
    var url = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=' + lat + '&lon=' + lng;
    fetch(url, { headers: { 'Accept': 'application/json' } })
      .then(function(res) { return res.json(); })
      .then(function(data) {
        var addr = data.display_name || (lat.toFixed(5) + ', ' + lng.toFixed(5));
        var pincode = data.address && data.address.postcode ? data.address.postcode : null;
        if (markerToUpdate) {
          markerToUpdate.setPopupContent(
            '<div class="popup-title">📍 Selected Pickup</div>' +
            '<div class="popup-subtitle">' + addr + '</div>'
          ).openPopup();
        }
        post({ type: 'pick', lat: lat, lng: lng, address: addr, pincode: pincode });
      })
      .catch(function() {
        post({ type: 'pick', lat: lat, lng: lng });
      });
  }

  // --------------------------------------------------------- NOMINATIM SEARCH
  window.searchNominatim = function() {
    var input = document.getElementById('nominatim-query');
    var dropdown = document.getElementById('search-dropdown');
    if (!input || !dropdown) return;
    var q = input.value.trim();
    if (!q) return;

    dropdown.style.display = 'block';
    dropdown.innerHTML = '<div class="search-item">Searching places…</div>';

    var url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=in&q=' + encodeURIComponent(q);
    fetch(url, { headers: { 'Accept': 'application/json' } })
      .then(function(r) { return r.json(); })
      .then(function(items) {
        if (!items || items.length === 0) {
          dropdown.innerHTML = '<div class="search-item">No places found</div>';
          return;
        }
        dropdown.innerHTML = '';
        items.forEach(function(item) {
          var div = document.createElement('div');
          div.className = 'search-item';
          div.innerText = item.display_name;
          div.onclick = function() {
            var lat = parseFloat(item.lat);
            var lon = parseFloat(item.lon);
            dropdown.style.display = 'none';
            input.value = item.display_name;
            map.flyTo([lat, lon], 16, { duration: 1.2 });
            dropPickMarker(lat, lon, item.display_name, item.address ? item.address.postcode : null);
          };
          dropdown.appendChild(div);
        });
      })
      .catch(function() {
        dropdown.innerHTML = '<div class="search-item">Search failed</div>';
      });
  };

  function dropPickMarker(lat, lng, addressText, pincode) {
    if (currentPickMarker) layer.removeLayer(currentPickMarker);

    var icon = L.divIcon({
      className: 'custom-pin-marker',
      html: '<div class="pin-pulse"></div><span class="pin-icon">📍</span>',
      iconSize: [32, 32],
      iconAnchor: [16, 28],
      popupAnchor: [0, -28]
    });

    currentPickMarker = L.marker([lat, lng], { icon: icon }).addTo(layer);

    if (addressText) {
      currentPickMarker.bindPopup(
        '<div class="popup-title">📍 Selected Pickup</div>' +
        '<div class="popup-subtitle">' + addressText + '</div>'
      ).openPopup();
      post({ type: 'pick', lat: lat, lng: lng, address: addressText, pincode: pincode });
    } else {
      currentPickMarker.bindPopup('<div class="popup-title">📍 Locating address…</div>').openPopup();
      reverseGeocodeNominatim(lat, lng, currentPickMarker);
    }
  }

  // ------------------------------------------------------------- OSRM ROUTING
  function fetchAndDrawOsrmRoute(origin, destination) {
    var hud = document.getElementById('route-hud');
    var hudText = document.getElementById('route-hud-text');
    if (hud) hud.style.display = 'flex';
    if (hudText) hudText.innerHTML = 'Calculating road route…';

    var url = 'https://router.project-osrm.org/route/v1/driving/' +
      origin[1] + ',' + origin[0] + ';' + destination[1] + ',' + destination[0] +
      '?overview=full&geometries=geojson&steps=false';

    fetch(url)
      .then(function(res) { return res.json(); })
      .then(function(data) {
        var r = data.routes && data.routes[0];
        if (!r || !r.geometry || !r.geometry.coordinates) return;

        var latLngs = r.geometry.coordinates.map(function(c) { return [c[1], c[0]]; });
        drawRoutePolyline(latLngs);

        var km = (r.distance / 1000).toFixed(1);
        var mins = Math.max(1, Math.round(r.duration / 60));
        if (hudText) {
          hudText.innerHTML = '<span>' + km + ' km</span> · <span>' + mins + ' min</span> driving';
        }
      })
      .catch(function(err) {
        console.warn('OSRM request error:', err);
        if (hud) hud.style.display = 'none';
      });
  }

  function drawRoutePolyline(pts) {
    routeLayer.clearLayers();
    if (!pts || pts.length < 2) return;

    // Outer dark casing for contrast on any map tile layer
    L.polyline(pts, {
      color: '#070b12',
      weight: 8,
      opacity: 0.7,
      lineCap: 'round',
      lineJoin: 'round'
    }).addTo(routeLayer);

    // Inner glowing active road route
    L.polyline(pts, {
      color: '#38bdf8',
      weight: 5,
      opacity: 0.95,
      lineCap: 'round',
      lineJoin: 'round'
    }).addTo(routeLayer);
  }

  // ------------------------------------------------------------- APPLY STATE
  window.applyState = function(state) {
    var signature = JSON.stringify(state);
    if (signature === lastSignature) return;
    lastSignature = signature;

    if (state.mapStyle && state.mapStyle !== currentStyle) {
      setTileLayer(state.mapStyle);
    }

    layer.clearLayers();
    routeLayer.clearLayers();
    currentPickMarker = null;

    var pts = [];
    var markers = state.markers || [];

    markers.forEach(function(m) {
      var isAmbulance = (m.label && m.label.toLowerCase().indexOf('ambulance') !== -1) || m.icon === '🚑';
      var isPickup = (m.label && m.label.toLowerCase().indexOf('pickup') !== -1) || m.icon === '📍';

      var marker;
      if (m.icon) {
        var html = '<div class="' + (isAmbulance ? 'ambulance-pulse' : 'pin-pulse') + '"></div>' +
                   '<span class="pin-icon">' + m.icon + '</span>';
        var icon = L.divIcon({
          className: 'custom-pin-marker',
          html: html,
          iconSize: [32, 32],
          iconAnchor: [16, 26],
          popupAnchor: [0, -26]
        });
        marker = L.marker([m.latitude, m.longitude], { icon: icon }).addTo(layer);
      } else {
        marker = L.circleMarker([m.latitude, m.longitude], {
          radius: m.radius || 10,
          color: m.color || '#38bdf8',
          fillColor: m.color || '#38bdf8',
          fillOpacity: 0.9,
          weight: 3
        }).addTo(layer);
      }

      if (m.label) {
        marker.bindTooltip(m.label, { permanent: false, direction: 'top' });
      }
      pts.push([m.latitude, m.longitude]);
    });

    var hud = document.getElementById('route-hud');
    var hudText = document.getElementById('route-hud-text');

    // 1. If explicit route coordinates are provided
    if (state.route && state.route.length > 1) {
      drawRoutePolyline(state.route);
      pts = pts.concat(state.route);

      // Measure approx length if hud exists
      if (hud && hudText) {
        hud.style.display = 'flex';
        hudText.innerHTML = 'Active road route (OSRM)';
      }
    }
    // 2. If autoRoute requested and we have 2 distinct markers
    else if (state.autoRoute && markers.length >= 2) {
      var origin = [markers[0].latitude, markers[0].longitude];
      var dest = [markers[1].latitude, markers[1].longitude];
      fetchAndDrawOsrmRoute(origin, dest);
    } else if (hud) {
      hud.style.display = 'none';
    }

    if (pts.length > 1) {
      map.fitBounds(L.latLngBounds(pts).pad(0.25));
    } else if (pts.length === 1) {
      map.setView(pts[0], Math.max(map.getZoom(), ${zoom}));
    }
  };

  // ------------------------------------------------------------- MAP EVENTS
  ${pickable ? `
  map.on('click', function(e) {
    dropPickMarker(e.latlng.lat, e.latlng.lng);
  });
  ` : ''}

  // Close dropdown on outside click
  document.addEventListener('click', function(e) {
    var searchWrap = document.querySelector('.search-container');
    var dropdown = document.getElementById('search-dropdown');
    if (dropdown && searchWrap && !searchWrap.contains(e.target)) {
      dropdown.style.display = 'none';
    }
  });

  post({ type: 'ready' });
</script>
</body>
</html>`;
}

const styles = StyleSheet.create({
  wrap: {
    borderRadius: radius.md,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: '#0b1119',
    position: 'relative',
  },
  web: { flex: 1, backgroundColor: '#0b1119' },
});
