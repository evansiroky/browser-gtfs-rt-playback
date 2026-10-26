// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ping } from '@/test/fixtures';
import TripMap, { type TripMapProps } from './trip-map';

// jsdom has no WebGL: MapLibre is replaced by a recorder of what the component asks of it.
const fake = vi.hoisted(() => {
  type Handler = (event: unknown) => void;
  const state = {
    maps: [] as FakeMap[],
    markers: [] as FakeMarker[],
    popups: [] as FakePopup[],
  };
  class FakeBounds {
    points: [number, number][] = [];
    extend(point: [number, number]) {
      this.points.push(point);
      return this;
    }
    isEmpty() {
      return this.points.length === 0;
    }
    toArray() {
      const lons = this.points.map((p) => p[0]);
      const lats = this.points.map((p) => p[1]);
      return [
        [Math.min(...lons), Math.min(...lats)],
        [Math.max(...lons), Math.max(...lats)],
      ];
    }
  }
  class FakeMap {
    handlers = new Map<string, Handler>();
    sources = new Map<string, { data: unknown; setData: (data: unknown) => void }>();
    layers: unknown[] = [];
    fitBounds = vi.fn();
    easeTo = vi.fn();
    removed = false;
    constructor(public options: unknown) {
      state.maps.push(this);
    }
    on(name: string, handler: Handler) {
      this.handlers.set(name, handler);
    }
    fire(name: string, event: unknown = {}) {
      this.handlers.get(name)?.(event);
    }
    addControl() {}
    getSource(id: string) {
      return this.sources.get(id);
    }
    addSource(id: string, spec: { data: unknown }) {
      const source = {
        data: spec.data,
        setData(data: unknown) {
          source.data = data;
        },
      };
      this.sources.set(id, source);
    }
    addLayer(layer: unknown) {
      this.layers.push(layer);
    }
    remove() {
      this.removed = true;
    }
  }
  class FakeMarker {
    lngLat: [number, number] | null = null;
    removed = false;
    constructor(public options: { element: HTMLElement }) {
      state.markers.push(this);
    }
    setLngLat(lngLat: [number, number]) {
      this.lngLat = lngLat;
      return this;
    }
    addTo() {
      return this;
    }
    remove() {
      this.removed = true;
    }
    getElement() {
      return this.options.element;
    }
  }
  class FakePopup {
    lngLat: [number, number] | null = null;
    content: HTMLElement | null = null;
    removed = false;
    constructor() {
      state.popups.push(this);
    }
    setLngLat(lngLat: [number, number]) {
      this.lngLat = lngLat;
      return this;
    }
    setDOMContent(content: HTMLElement) {
      this.content = content;
      return this;
    }
    addTo() {
      return this;
    }
    remove() {
      this.removed = true;
    }
  }
  return { state, FakeBounds, FakeMap, FakeMarker, FakePopup };
});

vi.mock('maplibre-gl', () => ({
  Map: fake.FakeMap,
  Marker: fake.FakeMarker,
  Popup: fake.FakePopup,
  LngLatBounds: fake.FakeBounds,
  NavigationControl: class {},
  setWorkerUrl: () => {},
}));

describe('TripMap', () => {
  const SHAPE: [number, number][] = [
    [37.7, -122.5],
    [37.8, -122.4],
  ];
  const onSelect = vi.fn();
  const live = () => fake.state.markers.filter((marker) => !marker.removed);
  const map = () => fake.state.maps.at(-1)!;

  function props(overrides: Partial<TripMapProps> = {}): TripMapProps {
    return {
      shape: SHAPE,
      pings: [ping(1), ping(2)],
      timezone: 'America/Los_Angeles',
      selection: null,
      onSelect,
      ...overrides,
    };
  }

  beforeEach(() => {
    fake.state.maps.length = 0;
    fake.state.markers.length = 0;
    fake.state.popups.length = 0;
    onSelect.mockReset();
  });

  it('draws the shape as a GeoJSON line of [longitude, latitude] pairs once the style has loaded', () => {
    render(<TripMap {...props()} />);
    expect(map().sources.size).toBe(0);
    act(() => map().fire('load'));
    expect(map().sources.get('trip-shape')?.data).toMatchObject({
      geometry: {
        type: 'LineString',
        coordinates: [
          [-122.5, 37.7],
          [-122.4, 37.8],
        ],
      },
    });
    expect(map().layers).toHaveLength(1);
  });

  it('replaces the line rather than adding a second source when the shape changes', () => {
    const { rerender } = render(<TripMap {...props()} />);
    act(() => map().fire('load'));
    rerender(<TripMap {...props({ shape: [[37.9, -122.3]] })} />);
    expect(map().sources.size).toBe(1);
    expect(map().sources.get('trip-shape')?.data).toMatchObject({
      geometry: { coordinates: [[-122.3, 37.9]] },
    });
  });

  it('puts one marker per ping with coordinates, numbered with the ping sequence', () => {
    render(
      <TripMap
        {...props({
          pings: [ping(7), ping(9, { latitude: null, longitude: null }), ping(12)],
        })}
      />,
    );
    expect(live().map((m) => m.getElement().textContent)).toEqual(['7', '12']);
    expect(live().map((m) => m.getElement().dataset.sequence)).toEqual(['7', '12']);
    expect(live()[0]!.lngLat).toEqual([-122.41, 37.787]);
    expect(live()[0]!.getElement().getAttribute('aria-label')).toBe(
      'Vehicle position 7, bus-7, 23:58:27',
    );
  });

  it('adds new markers on refresh and drops expired ones, never renumbering', () => {
    const { rerender } = render(<TripMap {...props({ pings: [ping(3), ping(4)] })} />);
    const [three, four] = live();
    rerender(<TripMap {...props({ pings: [ping(4), ping(5)] })} />);
    expect(three!.removed).toBe(true);
    expect(four!.removed).toBe(false);
    expect(live().map((m) => m.getElement().textContent)).toEqual(['4', '5']);
    expect(live()[0]).toBe(four);
  });

  it('reports a marker click with its sequence', () => {
    render(<TripMap {...props()} />);
    fireEvent.click(live()[1]!.getElement());
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(2);
  });

  it('fits the shape and all markers on first load, and again only when the extent changes', () => {
    const { rerender } = render(<TripMap {...props()} />);
    expect(map().fitBounds).toHaveBeenCalledTimes(1);
    expect(map().fitBounds.mock.calls[0]![0].toArray()).toEqual([
      [-122.5, 37.7],
      [-122.4, 37.8],
    ]);
    rerender(<TripMap {...props({ pings: [ping(1), ping(2), ping(3)] })} />);
    expect(map().fitBounds).toHaveBeenCalledTimes(1);
    rerender(<TripMap {...props({ pings: [ping(1, { latitude: 38.5 })] })} />);
    expect(map().fitBounds).toHaveBeenCalledTimes(2);
  });

  it('does not fit again once the user has moved the map', () => {
    const { rerender } = render(<TripMap {...props()} />);
    // The fit itself is a programmatic move, with no DOM event.
    act(() => map().fire('movestart', {}));
    rerender(<TripMap {...props({ pings: [ping(1, { latitude: 38.5 })] })} />);
    expect(map().fitBounds).toHaveBeenCalledTimes(2);

    act(() => map().fire('movestart', { originalEvent: new MouseEvent('mousedown') }));
    rerender(<TripMap {...props({ pings: [ping(1, { latitude: 39.5 })] })} />);
    expect(map().fitBounds).toHaveBeenCalledTimes(2);
  });

  it('opens a popup with the ping time and vehicle on a marker click selection, without panning', () => {
    const pings = [ping(1), ping(2, { vehicleId: 'bus-8', vehicleLabel: 'Eight' })];
    const { rerender } = render(<TripMap {...props({ pings })} />);
    rerender(<TripMap {...props({ pings, selection: { sequence: 2, pan: false } })} />);
    const popup = fake.state.popups.at(-1)!;
    expect(popup.content!.textContent).toContain('Position 2');
    expect(popup.content!.textContent).toContain('23:58:22');
    expect(popup.content!.textContent).toContain('bus-8 (Eight)');
    expect(map().easeTo).not.toHaveBeenCalled();
    expect(live()[1]!.getElement().dataset.selected).toBe('true');
    expect(live()[0]!.getElement().dataset.selected).toBe('false');
  });

  it('pans to the ping once for a row selection, not again on a refresh', () => {
    const pings = [ping(1), ping(2)];
    const selection = { sequence: 2, pan: true };
    const { rerender } = render(<TripMap {...props({ pings })} />);
    rerender(<TripMap {...props({ pings, selection })} />);
    expect(map().easeTo).toHaveBeenCalledTimes(1);
    expect(map().easeTo.mock.calls[0]![0].center).toEqual([ping(2).longitude, ping(2).latitude]);
    rerender(<TripMap {...props({ pings: [...pings, ping(3)], selection })} />);
    expect(map().easeTo).toHaveBeenCalledTimes(1);
    // The pan counts as the user's: the map is not refitted afterwards.
    rerender(<TripMap {...props({ pings: [ping(1, { latitude: 40 })], selection: null })} />);
    expect(map().fitBounds).toHaveBeenCalledTimes(1);
  });

  it('removes the popup when nothing is selected, and the map on unmount', () => {
    const pings = [ping(1)];
    const { rerender, unmount } = render(<TripMap {...props({ pings })} />);
    rerender(<TripMap {...props({ pings, selection: { sequence: 1, pan: false } })} />);
    const popup = fake.state.popups.at(-1)!;
    rerender(<TripMap {...props({ pings, selection: null })} />);
    expect(popup.removed).toBe(true);
    unmount();
    expect(map().removed).toBe(true);
    expect(live()).toHaveLength(0);
  });

  it('exposes what it draws for the end-to-end checks', () => {
    render(<TripMap {...props()} />);
    const region = screen.getByRole('region', { name: 'Map of the trip' });
    expect(region).toHaveAttribute('data-shape-points', '2');
    expect(region).toHaveAttribute('data-shape-first', '37.7,-122.5');
    expect(region).toHaveAttribute('data-shape-last', '37.8,-122.4');
  });
});
