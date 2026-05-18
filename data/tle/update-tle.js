#!/usr/bin/env node

import * as https from "https";
import * as fs from "fs";
import * as process from "process";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Change dir to the location of this script
process.chdir(__dirname);

async function downloadTLE(groupName) {
  const url = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${groupName}&FORMAT=tle`;
  const path = "groups/";
  const filename = `${groupName}.txt`;
  const targetPath = path + filename;
  process.stdout.write(`Downloading ${filename}...`);

  const data = await new Promise((resolve, reject) => {
    const request = https.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        process.stdout.write(` Failed (${res.statusCode})\n`);
        resolve(null);
        return;
      }

      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });

    request.on("error", reject);
  });

  if (data === null) {
    return;
  }

  await fs.promises.writeFile(targetPath, data);
  process.stdout.write(` Done\n`);
}

// https://celestrak.org/NORAD/elements/
// [...document.links].filter((link) => link.href.match(/gp.php\?GROUP=/)).map((link => link.href.match(/GROUP=(?<name>.*)&FORMAT/).groups.name));
const groups = [
  "last-30-days",
  "stations",
  // "visual",
  "active",
  // "analyst",
  // "1982-092",
  // "1999-025",
  // "iridium-33-debris",
  // "cosmos-2251-debris",
  "weather",
  // "noaa",
  // "goes",
  "resource",
  // "sarsat",
  // "dmc",
  // "tdrss",
  // "argos",
  "planet",
  "spire",
  // "geo",
  // "intelsat",
  // "ses",
  // "iridium",
  "iridium-NEXT",
  "starlink",
  "oneweb",
  // "orbcomm",
  "globalstar",
  // "swarm",
  // "amateur",
  // "x-comm",
  // "other-comm",
  // "satnogs",
  // "gorizont",
  // "raduga",
  // "molniya",
  "gnss",
  // "gps-ops",
  // "glo-ops",
  // "galileo",
  // "beidou",
  // "sbas",
  // "nnss",
  // "musson",
  "science",
  // "geodetic",
  // "engineering",
  // "education",
  // "military",
  // "radar",
  "cubesat",
  // "other",
  "eutelsat",
];

for (const group of groups) {
  await downloadTLE(group);
}
