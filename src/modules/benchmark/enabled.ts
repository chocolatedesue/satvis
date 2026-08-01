// PROTOTYPE — see ./README.md.
//
// Its own file so the entrypoint and the toolbar can ask the question without
// pulling the framework (and the report tables) into the main chunk.

/**
 * The framework is off unless asked for: `?bench` in the url, or a dev server.
 *
 * A url parameter rather than a dev-only build flag on purpose — a dev build is
 * unminified and runs Vue in development mode, so its numbers are pessimistic by
 * an unknown factor. The measurement worth trusting is the one taken against
 * `pnpm bench`, which is a production build.
 */
export const benchmarkEnabled = (): boolean => import.meta.env.DEV || new URLSearchParams(window.location.search).has("bench");
