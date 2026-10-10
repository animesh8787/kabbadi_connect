import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useRef } from "react";

export interface Marker {
  lat: number;
  lng: number;
  label: string;
}

const DELHI = { lat: 28.6139, lng: 77.209 };

/** Leaflet map; numbered markers, optional tap-to-pick. Tiles are OpenStreetMap (light use only). */
export function MapView({ markers, pin, onPick, height = 240 }: { markers?: Marker[]; pin?: { lat: number; lng: number } | null; onPick?: (p: { lat: number; lng: number }) => void; height?: number }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | undefined>(undefined);
  const layer = useRef<L.LayerGroup | undefined>(undefined);
  const pick = useRef(onPick);
  pick.current = onPick;

  useEffect(() => {
    const m = L.map(el.current!, { attributionControl: true }).setView([DELHI.lat, DELHI.lng], 12);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "© OpenStreetMap contributors",
    }).addTo(m);
    layer.current = L.layerGroup().addTo(m);
    m.on("click", (e) => pick.current?.({ lat: e.latlng.lat, lng: e.latlng.lng }));
    map.current = m;
    return () => {
      m.remove();
    };
  }, []);

  const key = JSON.stringify([markers, pin]);
  useEffect(() => {
    const g = layer.current!;
    g.clearLayers();
    const pts: L.LatLngExpression[] = [];
    for (const k of markers ?? []) {
      L.marker([k.lat, k.lng], { icon: L.divIcon({ className: "stop-pin", html: `<span>${k.label}</span>`, iconSize: [28, 28] }) }).addTo(g);
      pts.push([k.lat, k.lng]);
    }
    if (markers && markers.length > 1) L.polyline(pts, { color: "#1b7a43", weight: 3, opacity: 0.7 }).addTo(g);
    if (pin) {
      L.marker([pin.lat, pin.lng]).addTo(g);
      pts.push([pin.lat, pin.lng]);
    }
    if (pts.length) map.current!.fitBounds(L.latLngBounds(pts), { padding: [30, 30], maxZoom: 16 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return <div ref={el} style={{ height }} className="map" role="application" aria-label="map" />;
}
