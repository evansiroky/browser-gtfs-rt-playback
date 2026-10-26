import type { Ping } from '@gtfs-rt-debugger/shared';
import {
  LngLatBounds,
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  Popup,
  setWorkerUrl,
  type GeoJSONSource,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { useEffect, useMemo, useRef, useState } from 'react';
import { MAP_STYLE_URL } from '@/lib/map-style';
import { hasCoordinates, pingTime, vehicleText } from '@/lib/ping-fields';
import type { PingSelection } from './selection';

/** A point as `[latitude, longitude]`, the order the polyline decodes to. */
type LatLng = readonly [number, number];

// The bundler does not find the worker file by itself; it is served from this origin.
setWorkerUrl(workerUrl);

const SHAPE_SOURCE = 'trip-shape';
const SHAPE_LAYER = 'trip-shape-line';
const FIT_PADDING = 48;
const FIT_MAX_ZOOM = 16;

const MARKER_CLASS =
  'flex size-6 cursor-pointer items-center justify-center rounded-full border-2 border-white bg-blue-700 text-[10px] leading-none font-semibold text-white shadow-md outline-none focus-visible:ring-2 focus-visible:ring-ring data-[selected=true]:z-10 data-[selected=true]:bg-orange-600 data-[selected=true]:ring-4 data-[selected=true]:ring-orange-300';

export interface TripMapProps {
  /** The decoded shape, or null when the trip has none. */
  shape: readonly LatLng[] | null;
  pings: Ping[];
  timezone: string | null;
  selection: PingSelection | null;
  onSelect: (sequence: number) => void;
}

function bounds(shape: readonly LatLng[] | null, pings: Ping[]): LngLatBounds | null {
  const box = new LngLatBounds();
  for (const [lat, lon] of shape ?? []) box.extend([lon, lat]);
  for (const ping of pings) if (hasCoordinates(ping)) box.extend([ping.longitude, ping.latitude]);
  return box.isEmpty() ? null : box;
}

function popupContent(ping: Ping, timezone: string | null): HTMLElement {
  const node = document.createElement('div');
  node.className = 'text-xs text-black';
  const title = document.createElement('strong');
  title.textContent = `Position ${ping.sequence}`;
  const time = document.createElement('div');
  time.textContent = pingTime(ping, timezone) ?? '';
  const vehicle = document.createElement('div');
  vehicle.textContent = vehicleText(ping);
  node.append(title, time, vehicle);
  return node;
}

/**
 * The trip's shape as a line under one round marker per ping with coordinates, numbered with the
 * ping's server-assigned sequence. The view fits the content until the user moves it.
 */
export default function TripMap({ shape, pings, timezone, selection, onSelect }: TripMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markers = useRef(new Map<number, Marker>());
  const popup = useRef<Popup | null>(null);
  const userMoved = useRef(false);
  const fittedTo = useRef<string | null>(null);
  const panned = useRef<PingSelection | null>(null);
  const onSelectRef = useRef(onSelect);
  const [styleReady, setStyleReady] = useState(false);

  useEffect(() => {
    onSelectRef.current = onSelect;
  });

  useEffect(() => {
    const map = new MapLibreMap({
      container: container.current!,
      style: MAP_STYLE_URL,
      center: [0, 0],
      zoom: 1,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    // Programmatic moves (the fit, a row's pan) carry no DOM event; the user's gestures and the
    // zoom buttons do.
    map.on('movestart', (event) => {
      if ((event as { originalEvent?: unknown }).originalEvent) userMoved.current = true;
    });
    map.on('load', () => setStyleReady(true));
    const markerMap = markers.current;
    return () => {
      popup.current?.remove();
      popup.current = null;
      for (const marker of markerMap.values()) marker.remove();
      markerMap.clear();
      map.remove();
      mapRef.current = null;
      userMoved.current = false;
      fittedTo.current = null;
      setStyleReady(false);
    };
  }, []);

  // The shape: a GeoJSON line, [longitude, latitude] pairs.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady) return;
    const data = {
      type: 'Feature' as const,
      properties: {},
      geometry: {
        type: 'LineString' as const,
        coordinates: (shape ?? []).map(([lat, lon]) => [lon, lat]),
      },
    };
    const source = map.getSource<GeoJSONSource>(SHAPE_SOURCE);
    if (source) {
      source.setData(data);
      return;
    }
    map.addSource(SHAPE_SOURCE, { type: 'geojson', data });
    map.addLayer({
      id: SHAPE_LAYER,
      type: 'line',
      source: SHAPE_SOURCE,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#2563eb', 'line-width': 4, 'line-opacity': 0.75 },
    });
  }, [shape, styleReady]);

  // One marker per ping with coordinates, keyed by sequence: a refresh adds the new ones and
  // drops the expired ones, and never renumbers.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const wanted = new Map<number, Ping & { latitude: number; longitude: number }>();
    for (const ping of pings) if (hasCoordinates(ping)) wanted.set(ping.sequence, ping);
    for (const [sequence, marker] of markers.current) {
      if (!wanted.has(sequence)) {
        marker.remove();
        markers.current.delete(sequence);
      }
    }
    for (const [sequence, ping] of wanted) {
      if (markers.current.has(sequence)) continue;
      const element = document.createElement('button');
      element.type = 'button';
      element.className = MARKER_CLASS;
      element.dataset.sequence = String(sequence);
      element.textContent = String(sequence);
      element.addEventListener('click', (event) => {
        event.stopPropagation();
        onSelectRef.current(sequence);
      });
      markers.current.set(
        sequence,
        new Marker({ element }).setLngLat([ping.longitude, ping.latitude]).addTo(map),
      );
    }
    // Names and labels follow the data (time needs the timezone).
    for (const [sequence, ping] of wanted) {
      const element = markers.current.get(sequence)!.getElement();
      const time = pingTime(ping, timezone);
      element.setAttribute(
        'aria-label',
        `Vehicle position ${sequence}, ${vehicleText(ping)}${time ? `, ${time}` : ''}`,
      );
    }
  }, [pings, timezone]);

  // Fit to the content until the user moves the map; again only when the content's extent changes.
  const extent = useMemo(() => bounds(shape, pings), [shape, pings]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !extent || userMoved.current) return;
    const key = extent.toArray().join(',');
    if (fittedTo.current === key) return;
    fittedTo.current = key;
    map.fitBounds(extent, { padding: FIT_PADDING, maxZoom: FIT_MAX_ZOOM, animate: false });
  }, [extent]);

  // The selected ping: its marker on top, a popup on it, and the map panned to it for a row click.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    for (const [sequence, marker] of markers.current) {
      marker.getElement().dataset.selected = String(sequence === selection?.sequence);
    }
    popup.current?.remove();
    popup.current = null;
    const ping = pings.find((candidate) => candidate.sequence === selection?.sequence);
    if (!selection || !ping || !hasCoordinates(ping)) return;
    popup.current = new Popup({ offset: 16, closeButton: false, closeOnClick: false })
      .setLngLat([ping.longitude, ping.latitude])
      .setDOMContent(popupContent(ping, timezone))
      .addTo(map);
    if (selection.pan && panned.current !== selection) {
      // A pan the user asked for counts as moving the map; a refresh does not repeat it.
      panned.current = selection;
      userMoved.current = true;
      map.easeTo({ center: [ping.longitude, ping.latitude], duration: 300 });
    }
  }, [selection, pings, timezone]);

  const shapePoints = shape?.length ?? 0;
  return (
    <div
      ref={container}
      role="region"
      aria-label="Map of the trip"
      data-map
      data-shape-points={shapePoints}
      data-shape-first={shapePoints > 0 ? shape![0]!.join(',') : undefined}
      data-shape-last={shapePoints > 0 ? shape![shapePoints - 1]!.join(',') : undefined}
      data-style-loaded={styleReady}
      className="h-[22rem] w-full overflow-hidden rounded-lg border sm:h-[28rem]"
    />
  );
}
