/** The ping the user picked, from a marker or from a row. */
export interface PingSelection {
  sequence: number;
  /** A row click pans the map to the marker; a marker click does not. */
  pan: boolean;
}
