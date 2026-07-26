// The wire form of a layer selection: a provider name with an optional opacity
// suffix, `ArcGis` or `ArcGis_0.5`.
//
// Kept here, free of Cesium, because three places need to read it — the url
// codec, the store action that enforces the single-base-layer rule, and
// CesiumController when it builds the ImageryLayer — and they were each
// splitting on "_" for themselves.

export interface LayerSelection {
  provider: string;
  // Absent means "the provider's own default opacity".
  alpha?: number;
}

/** Undefined when the token is not a usable selection. The provider name is not checked here. */
export function parseLayer(token: string): LayerSelection | undefined {
  const separator = token.indexOf("_");
  if (separator === -1) {
    return token === "" ? undefined : { provider: token };
  }
  const provider = token.slice(0, separator);
  const rawAlpha = token.slice(separator + 1);
  if (provider === "" || rawAlpha === "") {
    return undefined;
  }
  const alpha = Number(rawAlpha);
  // Anything outside 0..1 would silently produce an invisible or over-bright
  // layer, so it is not a selection we are willing to store.
  if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
    return undefined;
  }
  return { provider, alpha };
}

export function formatLayer(selection: LayerSelection): string {
  return selection.alpha === undefined ? selection.provider : `${selection.provider}_${selection.alpha}`;
}

/** The provider a token names, ignoring any opacity, or undefined if unusable. */
export function layerProvider(token: string): string | undefined {
  return parseLayer(token)?.provider;
}
