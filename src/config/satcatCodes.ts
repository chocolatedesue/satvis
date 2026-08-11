// CelesTrak SATCAT code tables.
//
// The codes travel on the wire, the labels are resolved here: an owner code is
// 2-4 bytes on ~12,600 records where "European Organization for Meteorological
// Satellites" is 54, and the mapping changes far more often than the codes do
// (CelesTrak adds a country per launch year). Keeping it in the app also means a
// correction ships with a deploy rather than a full GP refresh.
//
// Every lookup falls back to the raw code. These lists WILL go stale — a new
// nation reaches orbit and the record arrives before this file knows about it —
// and "SKOR" is a far better cell than a blank one.
//
// Sources, re-check when adding:
//   https://celestrak.org/satcat/sources.php      (owner)
//   https://celestrak.org/satcat/launchsites.php  (launch site)
//   https://celestrak.org/satcat/status.php       (operational status)
//   https://celestrak.org/satcat/satcat-format.php (orbit type)
//
// This module must stay Cesium-free (node-env vitest exercises it).

// Country or organization that owns the satellite (SATCAT `OWNER`).
//
// Names are CelesTrak's own, verbatim and deliberately: "who owns this satellite"
// is a question with contested answers, and passing upstream's wording through
// unedited keeps this a data table rather than an editorial one.
export const SATCAT_OWNER: Record<string, string> = {
  AB: "Arab Satellite Communications Organization",
  ABS: "Asia Broadcast Satellite",
  AC: "Asia Satellite Telecommunications Company",
  ALG: "Algeria",
  ANG: "Angola",
  ARGN: "Argentina",
  ARM: "Armenia",
  ASRA: "Austria",
  AUS: "Australia",
  AZER: "Azerbaijan",
  BEL: "Belgium",
  BELA: "Belarus",
  BERM: "Bermuda",
  BGD: "Bangladesh",
  BHR: "Bahrain",
  BHUT: "Bhutan",
  BOL: "Bolivia",
  BRAZ: "Brazil",
  BUL: "Bulgaria",
  BWA: "Botswana",
  CA: "Canada",
  CHBZ: "China/Brazil",
  CHLE: "Chile",
  CHTU: "China/Türkiye",
  CIS: "Commonwealth of Independent States",
  COL: "Colombia",
  CRI: "Costa Rica",
  CZCH: "Czech Republic",
  DEN: "Denmark",
  DJI: "Djibouti",
  ECU: "Ecuador",
  EGYP: "Egypt",
  ESA: "European Space Agency",
  ESRO: "European Space Research Organization",
  EST: "Estonia",
  ETH: "Ethiopia",
  EUME: "EUMETSAT",
  EUTE: "EUTELSAT",
  FGER: "France/Germany",
  FIN: "Finland",
  FR: "France",
  FRIT: "France/Italy",
  GER: "Germany",
  GHA: "Ghana",
  GLOB: "Globalstar",
  GREC: "Greece",
  GRSA: "Greece/Saudi Arabia",
  GUAT: "Guatemala",
  HRV: "Croatia",
  HUN: "Hungary",
  IM: "INMARSAT",
  IND: "India",
  INDO: "Indonesia",
  IRAN: "Iran",
  IRAQ: "Iraq",
  IRID: "Iridium",
  IRL: "Ireland",
  ISRA: "Israel",
  ISRO: "Indian Space Research Organisation",
  ISS: "International Space Station",
  IT: "Italy",
  ITSO: "INTELSAT",
  JPN: "Japan",
  KAZ: "Kazakhstan",
  KEN: "Kenya",
  LAOS: "Laos",
  LKA: "Sri Lanka",
  LTU: "Lithuania",
  LUXE: "Luxembourg",
  MA: "Morocco",
  MALA: "Malaysia",
  MCO: "Monaco",
  MDA: "Moldova",
  MEX: "Mexico",
  MMR: "Myanmar",
  MNE: "Montenegro",
  MNG: "Mongolia",
  MUS: "Mauritius",
  NATO: "NATO",
  NETH: "Netherlands",
  NICO: "New ICO",
  NIG: "Nigeria",
  NKOR: "North Korea",
  NOR: "Norway",
  NPL: "Nepal",
  NZ: "New Zealand",
  O3B: "O3b Networks",
  ORB: "ORBCOMM",
  PAKI: "Pakistan",
  PERU: "Peru",
  POL: "Poland",
  POR: "Portugal",
  PRC: "People's Republic of China",
  PRES: "People's Republic of China/ESA",
  PRY: "Paraguay",
  QAT: "Qatar",
  RASC: "RascomStar-QAF",
  ROC: "Taiwan",
  ROM: "Romania",
  RP: "Philippines",
  RWA: "Rwanda",
  SAFR: "South Africa",
  SAUD: "Saudi Arabia",
  SDN: "Sudan",
  SEAL: "Sea Launch",
  SEN: "Senegal",
  SES: "SES",
  SGJP: "Singapore/Japan",
  SING: "Singapore",
  SKOR: "Republic of Korea",
  SLB: "Solomon Islands",
  SPN: "Spain",
  STCT: "Singapore/Taiwan",
  SVN: "Slovenia",
  SWED: "Sweden",
  SWTZ: "Switzerland",
  TBD: "To Be Determined",
  THAI: "Thailand",
  TMMC: "Turkmenistan/Monaco",
  TUN: "Tunisia",
  TURK: "Türkiye",
  UAE: "United Arab Emirates",
  UK: "United Kingdom",
  UKR: "Ukraine",
  UNK: "Unknown",
  URY: "Uruguay",
  US: "United States",
  USBZ: "United States/Brazil",
  VAT: "Vatican City State",
  VENZ: "Venezuela",
  VTNM: "Vietnam",
  ZWE: "Zimbabwe",
};

// Where it went up from (SATCAT `LAUNCH_SITE`). Trimmed to the site itself —
// upstream appends the country, which the owner row usually already implies and
// which would push the value past the width the info panel has for it.
export const SATCAT_LAUNCH_SITE: Record<string, string> = {
  AFETR: "Cape Canaveral, Florida",
  AFWTR: "Vandenberg, California",
  ALCLC: "Alcântara, Brazil",
  ANDSP: "Andøya Spaceport, Norway",
  BOS: "Bowen Orbital Spaceport, Australia",
  CAS: "Canaries Airspace",
  DLS: "Dombarovskiy, Russia",
  ERAS: "Eastern Range Airspace",
  FRGUI: "Kourou, French Guiana",
  HGSTR: "Hammaguira, Algeria",
  JJSLA: "Jeju Island Sea Launch Area",
  JSC: "Jiuquan, China",
  KODAK: "Kodiak, Alaska",
  KSCUT: "Uchinoura, Japan",
  KWAJ: "Kwajalein Atoll",
  KYMSC: "Kapustin Yar, Russia",
  NSC: "Naro, Republic of Korea",
  PLMSC: "Plesetsk, Russia",
  RLLB: "Mahia Peninsula, New Zealand",
  SCSLA: "South China Sea Launch Area",
  SEAL: "Sea Launch Platform",
  SEMLS: "Semnan, Iran",
  SMTS: "Shahrud, Iran",
  SNMLP: "San Marco Platform, Kenya",
  SPKII: "Space Port Kii, Japan",
  SRILR: "Satish Dhawan, India",
  SUBL: "Submarine Launch Platform",
  SVOBO: "Svobodnyy, Russia",
  TAISC: "Taiyuan, China",
  TANSC: "Tanegashima, Japan",
  TYMSC: "Baikonur, Kazakhstan",
  UNK: "Unknown",
  VOSTO: "Vostochny, Russia",
  WLPIS: "Wallops Island, Virginia",
  WOMRA: "Woomera, Australia",
  WRAS: "Western Range Airspace",
  WSC: "Wenchang, China",
  XICLF: "Xichang, China",
  YAVNE: "Yavne, Israel",
  YSLA: "Yellow Sea Launch Area",
  YUN: "Yunsong, North Korea",
};

// Operational status (SATCAT `OPS_STATUS_CODE`). CelesTrak counts +, P, B, S and
// X as active; note that active does not imply powered or communicating (a
// geodetic reflector is active and inert).
export const SATCAT_OPS_STATUS: Record<string, string> = {
  "+": "Operational",
  "-": "Nonoperational",
  P: "Partially operational",
  B: "Backup/standby",
  S: "Spare",
  X: "Extended mission",
  D: "Decayed",
  "?": "Unknown",
};

// How the object moves (SATCAT `ORBIT_TYPE`). `ORB` — a normal orbit — is the
// answer for all but a handful of the satellites we serve and is suppressed at
// display time rather than listed as a fact (see getSatelliteInfo).
export const SATCAT_ORBIT_TYPE: Record<string, string> = {
  ORB: "Orbiting",
  LAN: "Landed",
  IMP: "Impacted",
  DOC: "Docked",
  "R/T": "Roundtrip",
};

/** Resolve a SATCAT code to its label, falling back to the code itself. */
export function satcatLabel(table: Record<string, string>, code: string): string {
  return table[code] ?? code;
}
