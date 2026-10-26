/**
 * The map provider's origin. It is configured in exactly two places that must agree: here and
 * the server's `TILE_HOST` setting (default `DEFAULT_TILE_HOST` in `server/src/config.ts`), which
 * the Content-Security-Policy allows ([architecture](../../../specs/architecture.md#stack)).
 */
export const MAP_TILE_HOST = 'https://tiles.openfreemap.org';

/** The one style URL the map loads; the style names its tiles, sprites and glyphs on the same origin. */
export const MAP_STYLE_URL = `${MAP_TILE_HOST}/styles/liberty`;
