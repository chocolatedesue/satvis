// Where to go for the things this panel does not know: mass and radar cross
// section, conjunction data, decay history, a second opinion on the orbit.
//
// Every entry is keyed on the NORAD catalog number and nothing else, which is what
// makes the list a one-liner rather than a per-site integration. That constraint
// also decided what is *not* here — see the note at the bottom.

export interface ExternalLink {
  label: string;
  title: string;
  href: string;
}

/**
 * Ordered most-authoritative first. CelesTrak leads because it is where this app's
 * own element sets and SATCAT fields come from. It is the page that can settle a
 * disagreement with anything shown here.
 *
 * All five URL schemes were checked against 25544 rather than assumed — Heavens-Above
 * in particular uses `satid`, not the `CATNR`/`s`/`sat` the others use.
 */
export function externalLinks(satnum: string): ExternalLink[] {
  return [
    {
      label: "CelesTrak",
      title: "CelesTrak SATCAT entry — the catalog this app's data comes from",
      href: `https://celestrak.org/satcat/table-satcat.php?CATNR=${satnum}`,
    },
    {
      label: "Satcat",
      title: "satcat.com — mass, radar cross section, conjunctions",
      href: `https://www.satcat.com/sats/${satnum}`,
    },
    {
      label: "n2yo",
      title: "n2yo.com — live tracking and pass predictions",
      href: `https://www.n2yo.com/satellite/?s=${satnum}`,
    },
    {
      label: "Heavens-Above",
      title: "heavens-above.com — orbit diagrams and ground track",
      href: `https://heavens-above.com/orbit.aspx?satid=${satnum}`,
    },
    {
      label: "KeepTrack",
      title: "app.keeptrack.space — 3D orbital analysis",
      href: `https://app.keeptrack.space/?sat=${satnum}`,
    },
  ];
}

// Considered and left out, all for the same reason — no public page addressable by
// catalog number alone:
//
//   Space-Track, ESA DISCOSweb   behind a login, so a link would land on a sign-in
//                               form rather than on the satellite
//   Wikipedia, Gunter's Space    organised by mission name, which this app does not
//   Page, Jonathan's Space       hold in a form that survives being put in a URL
//   Report
//   orbit.ing-now.com            wants the international designator and a name slug
//                               in the path as well as the number
//
// Deliberately not added either: CelesTrak's `gp.php?CATNR=` element query. It is a
// data endpoint rather than a page, and the panel already shows those elements.
