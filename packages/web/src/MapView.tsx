import maplibregl, { type StyleSpecification } from "maplibre-gl/dist/maplibre-gl-csp";
import workerUrl from "maplibre-gl/dist/maplibre-gl-csp-worker?url";
import "maplibre-gl/dist/maplibre-gl.css";

// Same-origin worker script (not a blob): the API key is referer-restricted to this site, and blob workers send a different referer.
maplibregl.setWorkerUrl(workerUrl);
import { useEffect, useRef, useState } from "react";
import { mapsConfig } from "./auth";

export interface Marker {
  lat: number;
  lng: number;
  label: string;
}

const DELHI = { lat: 28.6139, lng: 77.209 };

/** Plain OpenStreetMap raster, used only when the Amazon Location key is missing or its style fails to load. */
const OSM: StyleSpecification = {
  version: 8,
  sources: { osm: { type: "raster", tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"], tileSize: 256, attribution: "© OpenStreetMap contributors", maxzoom: 19 } },
  layers: [{ id: "osm", type: "raster", source: "osm" }],
};

function styleUrl(): string | StyleSpecification {
  const { key, region, map } = mapsConfig();
  if (!key || !map) return OSM;
  return `https://maps.geo.${region}.amazonaws.com/maps/v0/maps/${map}/style-descriptor?key=${key}`;
}

/** Amazon Location (MapLibre) map; numbered markers, optional tap-to-pick. Same props as the old Leaflet map. */
export function MapView({ markers, pin, onPick, height = 240, line, follow }: { markers?: Marker[]; pin?: { lat: number; lng: number } | null; onPick?: (p: { lat: number; lng: number }) => void; height?: number; line?: [number, number][]; follow?: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | undefined>(undefined);
  const drawn = useRef<maplibregl.Marker[]>([]);
  const pick = useRef(onPick);
  pick.current = onPick;
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let m: maplibregl.Map;
    try {
      const { key } = mapsConfig();
      m = new maplibregl.Map({
        container: el.current!,
        style: styleUrl(),
        center: [DELHI.lng, DELHI.lat],
        zoom: 11,
        // Tile, glyph and sprite URLs inside the style do not carry the API key, so add it to every Amazon Location request.
        transformRequest: (url) => (key && url.includes("maps.geo.") && !url.includes("key=") ? { url: `${url}${url.includes("?") ? "&" : "?"}key=${key}` } : { url }),
      });
    } catch {
      // No WebGL (old phone, blocked): the rest of the screen still works.
      setFailed(true);
      return;
    }
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
    m.on("click", (e) => pick.current?.({ lat: e.lngLat.lat, lng: e.lngLat.lng }));
    let fellBack = false;
    m.on("error", () => {
      if (fellBack || m.isStyleLoaded()) return;
      fellBack = true;
      m.setStyle(OSM);
    });
    map.current = m;
    return () => {
      m.remove();
      map.current = undefined;
    };
  }, []);

  const fitted = useRef(false);
  const key = JSON.stringify([markers, pin, line?.length, line?.[0]]);
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const draw = () => {
      drawn.current.forEach((d) => d.remove());
      drawn.current = [];
      const bounds = new maplibregl.LngLatBounds();
      for (const k of markers ?? []) {
        const node = document.createElement("div");
        node.className = "stop-pin";
        node.innerHTML = `<span>${k.label}</span>`;
        drawn.current.push(new maplibregl.Marker({ element: node }).setLngLat([k.lng, k.lat]).addTo(m));
        bounds.extend([k.lng, k.lat]);
      }
      if (pin) {
        drawn.current.push(new maplibregl.Marker({ color: "#e8793d" }).setLngLat([pin.lng, pin.lat]).addTo(m));
        bounds.extend([pin.lng, pin.lat]);
      }
      const path = line ?? (markers ?? []).map((k) => [k.lng, k.lat]);
      const feature = { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: path } } as const;
      const src = m.getSource("route") as maplibregl.GeoJSONSource | undefined;
      if (path.length > 1) {
        if (src) src.setData(feature);
        else {
          m.addSource("route", { type: "geojson", data: feature });
          m.addLayer({ id: "route", type: "line", source: "route", paint: { "line-color": "#3ecf8e", "line-width": 3, "line-opacity": 0.8 } });
        }
      } else if (src) src.setData({ type: "FeatureCollection", features: [] });
      if (follow && pin) {
        // Navigation: keep the position in view; only fit the whole route once.
        if (!fitted.current && !bounds.isEmpty()) m.fitBounds(bounds, { padding: 40, maxZoom: 17, duration: 0 });
        else m.easeTo({ center: [pin.lng, pin.lat], zoom: Math.max(m.getZoom(), 16), duration: 400 });
        fitted.current = true;
      } else if (!bounds.isEmpty()) m.fitBounds(bounds, { padding: 30, maxZoom: 16, duration: 0 });
    };
    if (m.isStyleLoaded()) draw();
    else m.once("load", draw);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (failed) return <div className="map muted" style={{ height, display: "grid", placeItems: "center" }}>Map unavailable on this device</div>;
  return <div ref={el} style={{ height }} className="map" role="application" aria-label="map" />;
}
