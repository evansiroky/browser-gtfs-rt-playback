import type { ServiceCalendar } from './calendar.js';
import type {
  Row,
  ScheduleConfigurationError,
  ScheduleCounts,
  ScheduleStore,
  ScheduleTrip,
  TripTemplate,
} from './store.js';

export interface MemoryScheduleData {
  agency: { names: readonly string[]; timezone: string };
  routes: ReadonlyMap<string, Row>;
  trips: ReadonlyMap<string, ScheduleTrip>;
  calendar: ServiceCalendar;
  shapes: ReadonlyMap<string, string>;
  configurationErrors: readonly ScheduleConfigurationError[];
  estimatedBytes: number;
}

/** The {@link ScheduleStore} the loader builds: plain maps over the reduced data. */
export class MemoryScheduleStore implements ScheduleStore {
  readonly #data: MemoryScheduleData;

  constructor(data: MemoryScheduleData) {
    this.#data = data;
  }

  agency() {
    return this.#data.agency;
  }

  trip(tripId: string): Row | undefined {
    return this.#data.trips.get(tripId)?.row;
  }

  route(routeId: string): Row | undefined {
    return this.#data.routes.get(routeId);
  }

  frequencies(tripId: string): readonly Row[] {
    return this.#data.trips.get(tripId)?.frequencies ?? [];
  }

  template(tripId: string): TripTemplate | null {
    return this.#data.trips.get(tripId)?.template ?? null;
  }

  trips(): IterableIterator<ScheduleTrip> {
    return this.#data.trips.values();
  }

  operatesOn(serviceId: string, serviceDate: string): boolean {
    return this.#data.calendar.operatesOn(serviceId, serviceDate);
  }

  shape(shapeId: string): string | null {
    return this.#data.shapes.get(shapeId) ?? null;
  }

  configurationErrors(): readonly ScheduleConfigurationError[] {
    return this.#data.configurationErrors;
  }

  counts(): ScheduleCounts {
    return {
      trips: this.#data.trips.size,
      routes: this.#data.routes.size,
      shapes: this.#data.shapes.size,
      estimatedBytes: this.#data.estimatedBytes,
    };
  }
}
