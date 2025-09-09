/*
Design summary (Location command)

Goals
- Manage server-side Country/Region/City without downloading full taxonomy.
- Default location is empty. Use server endpoints for resolution.
- Show RegionID/CityID in output and choices; users never type IDs.

CLI
- location show: prints current or “unset”; --json for raw.
- location set:
  --detect: set via IP (server-side) without confirmation using Detect flag.
  --country-code <CC>, --region <name>, --city <name>: resolve via server search (non-interactive by names).
  Interactive fallback if ambiguous and TTY; fail in non-TTY.

Interactive flow (location set)
1) If --detect: PUT /v1/user/location { Detect: true } → print result.
2) Else: GET /v1/user/location (show current if set).
3) Manual selection:
   - Country: GET /v1/locations/countries?query=&limit=
   - Region:  GET /v1/locations/regions?country_code=&query=&limit=
   - City:    GET /v1/locations/cities?region_id=&query=&limit=
   Show IDs in labels, never as input.
4) Confirm and PUT /v1/user/location { country_code, region_id, city_id } → print final.

Non-interactive by names (no IDs as input)
- location set --country-code US --region "California" --city "San Francisco" -y
- Resolve names within scope; on ambiguity:
  - TTY: prompt to select.
  - Non-TTY: error listing top matches with IDs.

Server API
- GET /v1/user/location → { country_code, country, region_id, region, city_id, city } | null
- PUT /v1/user/location → { Detect?: true } OR { country_code, region_id, city_id }
- GET /v1/locations/countries?query=&limit=
- GET /v1/locations/regions?country_code=&query=&limit=
- GET /v1/locations/cities?region_id=&query=&limit=
*/

import { Command } from "commander";
import process from "node:process";
import { Confirm, Input, Select } from "../lib/prompt";
import * as api from "../lib/api";
import { log } from "../lib/log";

function isTTY(): boolean {
  return !!process.stdin.isTTY;
}

function fmtLocation(loc: api.LocationInfo | null | undefined): string {
  if (!loc || !loc.CountryCode) return "unset";
  const parts: string[] = [];
  const country = `${loc.CountryCode} ${loc.Country ?? ""}`.trim();
  parts.push(country);
  if (loc.Region) parts.push(`${loc.Region}`);
  if (loc.City) parts.push(`${loc.City}`);
  return parts.join(" › ");
}

async function pickFromSearch<T>(
  fetcher: (q: string) => Promise<T[]>,
  labeler: (x: T) => string,
  valuer: (x: T) => T,
  emptyHint: string,
  title: string,
): Promise<T> {
  const CHANGE_FILTER = "__CHANGE_FILTER__";
  const NEXT_PAGE = "__NEXT_PAGE__";
  const PREV_PAGE = "__PREV_PAGE__";
  const PAGE_SIZE = 15;

  for (;;) {
    const q = await Input.prompt({ message: `${title} - filter (empty to list)`, prefix: "" })
      .catch(() => null as string | null);
    if (q === null) throw new Error("Aborted by user.");

    const items = await fetcher(q ?? "");
    if (!items.length) {
      log.info(`No matches. ${emptyHint}`);
      continue;
    }

    // If exactly one match, select automatically
    if (items.length === 1) {
      return valuer(items[0]);
    }

    let page = 0;
    const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));

  // Selection loop with paging
    while (true) {
      const start = page * PAGE_SIZE;
      const end = Math.min(start + PAGE_SIZE, items.length);
      const pageSlice = items.slice(start, end);

      const choices: Array<{ name: string; value: unknown }> = pageSlice.map((it) => ({
        name: labeler(it),
        value: valuer(it) as unknown,
      }));

      if (page > 0) choices.push({ name: "◀ Prev page", value: PREV_PAGE });
      if (page < totalPages - 1) choices.push({ name: "Next page ▶", value: NEXT_PAGE });
      choices.push({ name: "↩ Change filter", value: CHANGE_FILTER });

      const msg = `${title} (page ${page + 1}/${totalPages})`;
      const sel = await Select.prompt({
        message: msg,
        options: choices as unknown as Array<{ name: string; value: unknown }>,
      })
        .catch(() => CHANGE_FILTER as unknown);

      if (sel === CHANGE_FILTER) break; // back to filter input
      if (sel === NEXT_PAGE) {
        page = Math.min(totalPages - 1, page + 1);
        continue;
      }
      if (sel === PREV_PAGE) {
        page = Math.max(0, page - 1);
        continue;
      }

      return sel as T;
    }
  }
}

async function interactiveSelect(): Promise<api.LocationInfo> {
  // Country (request more results to paginate locally)
  const country = await pickFromSearch<api.Country>(
    (q) => api.searchCountries(q, 300),
    (c) => `${c.CountryCode} — ${c.Country}`,
    (c) => c,
    "Refine filter and try again.",
    "Select country",
  );

  // Region
  const region = await pickFromSearch<api.Region>(
    (q) => api.searchRegions(country.CountryCode, q, 300),
    (r) => r.Region,
    (r) => r,
    "Try a different region name.",
    "Select region",
  );

  // City
  const city = await pickFromSearch<api.City>(
    (q) => api.searchCities(region.RegionID, q, 300),
    (c) => c.City,
    (c) => c,
    "Try a different city name.",
    "Select city",
  );

  const ok = await Confirm.prompt({
    message:
      `Save location: ${country.CountryCode} ${country.Country} › ${region.Region} › ${city.City}?`,
  });
  if (!ok) {
    throw new Error("Aborted by user.");
  }

  const saved = await api.setUserLocation({
    CountryCode: country.CountryCode,
    RegionID: region.RegionID,
    CityID: city.CityID,
  });

  return saved;
}

async function resolveRegionByName(
  CountryCode: string,
  regionName: string,
): Promise<api.Region | null> {
  const results = await api.searchRegions(CountryCode, regionName);
  if (!results.length) return null;
  if (results.length === 1) return results[0];
  if (isTTY()) {
    return await pickFromSearch(
      () => Promise.resolve(results),
      (r: api.Region) => r.Region,
      (r: api.Region) => r,
      "",
      `Multiple regions match "${regionName}". Select one`,
    );
  } else {
    const msg = results.slice(0, 10).map((r: api.Region) => r.Region).join("\n");
    throw new Error(
      `Ambiguous region name "${regionName}". Matches:\n${msg}\nRefine the --region value.`,
    );
  }
}

async function resolveCityByName(
  RegionID: string | number,
  cityName: string,
): Promise<api.City | null> {
  const results = await api.searchCities(RegionID, cityName);
  if (!results.length) return null;
  if (results.length === 1) return results[0];
  if (isTTY()) {
    return await pickFromSearch(
      () => Promise.resolve(results),
      (c: api.City) => c.City,
      (c: api.City) => c,
      "",
      `Multiple cities match "${cityName}". Select one`,
    );
  } else {
    const msg = results.slice(0, 10).map((c: api.City) => c.CityID).join("\n");
    throw new Error(
      `Ambiguous city name "${cityName}". Matches:\n${msg}\nRefine the --city value.`,
    );
  }
}

type NonInteractiveOpts = { countryCode?: string; region?: string; city?: string; yes?: boolean };
async function nonInteractiveSet(opts: NonInteractiveOpts): Promise<api.LocationInfo> {
  const cc = String(opts.countryCode ?? "").toUpperCase().trim();
  if (!/^[A-Z]{2}$/.test(cc)) {
    throw new Error("--country-code must be a 2-letter ISO code (e.g., US, CA).");
  }
  // Validate country exists via search; accept if found
  const countries = await api.searchCountries(cc);
  const country = countries.find((c) => c.CountryCode.toUpperCase() === cc) ??
    countries.find((c) => c.Country.toLowerCase() === cc.toLowerCase());
  if (!country) {
    throw new Error(`Unknown country code "${cc}".`);
  }

  if (!opts.region || !opts.city) {
    if (isTTY()) {
      log.info("Missing --region or --city. Switching to interactive to complete selection.");
      return await interactiveSelect();
    } else {
      throw new Error("Non-interactive requires --country-code, --region, and --city.");
    }
  }

  const regionName = String(opts.region).trim();
  const region = await resolveRegionByName(cc, regionName);
  if (!region) throw new Error(`Region not found: "${regionName}" in ${cc}.`);

  const cityName = String(opts.city).trim();
  const city = await resolveCityByName(region.RegionID, cityName);
  if (!city) throw new Error(`City not found: "${cityName}" in region "${region.Region}".`);

  if (!opts.yes) {
    const ok = await Confirm.prompt({
      message: `Save location: ${cc} › ${region.Region} › ${city.City}?`,
    });
    if (!ok) throw new Error("Aborted by user.");
  }

  return await api.setUserLocation({
    CountryCode: cc,
    RegionID: region.RegionID,
    CityID: city.CityID,
  });
}

const location = new Command("location")
  .description("Manage user location")
  .action(function (this: Command) {
    this.outputHelp();
  });

location
  .command("show")
  .description("Show current location")
  .option("--json", "Print raw JSON")
  .action(async (opts: { json?: boolean }) => {
    try {
      const loc = await api.getUserLocation();
      if (opts.json) {
        log.info(JSON.stringify(loc ?? null, null, 2));
        return;
      }
      log.info("Location: " + fmtLocation(loc));
    } catch (e: unknown) {
      log.error("Failed to get location:", e instanceof Error ? e.message : String(e));
    }
  });

location
  .command("set")
  .description("Set location (interactive by default)")
  .option("--detect", "Detect via IP and set without confirmation")
  .option("--country-code <CC:string>", "Country code (ISO 3166-1, 2 letters i.e. US, CA)")
  .option("--region <name:string>", "Region name i.e. California, Ontario")
  .option("--city <name:string>", "City name i.e. San Francisco, Toronto")
  .option("-y, --yes", "Skip confirmation")
  .action(
    async (
      opts: {
        detect?: boolean;
        countryCode?: string;
        region?: string;
        city?: string;
        yes?: boolean;
      },
    ) => {
      try {
        if (opts.detect) {
          const saved = await api.setUserLocation({ Detect: true });
          log.info(fmtLocation(saved));
          return;
        }

        const hasFlags = !!(opts.countryCode || opts.region || opts.city);
        if (hasFlags) {
          const saved = await nonInteractiveSet(opts);
          log.info(fmtLocation(saved));
          return;
        }

        // Interactive default
        const current = await api.getUserLocation().catch(() => null);
        if (current?.CountryCode) {
          log.info(`Current location: ${fmtLocation(current)}`);
        }

        const mode = await Select.prompt({
          message: "Choose how to set location",
          options: [
            { name: "Auto-detect via IP", value: "detect" },
            { name: "Select manually", value: "manual" },
          ],
        });

        if (mode === "detect") {
          const saved = await api.setUserLocation({ Detect: true });
          log.info(fmtLocation(saved));
          return;
        }

        const saved = await interactiveSelect();
        log.info(fmtLocation(saved));
      } catch (e: unknown) {
        log.error("Failed to set location:", e instanceof Error ? e.message : String(e));
      }
    },
  );

export const locationCommand = location;
export default locationCommand;
