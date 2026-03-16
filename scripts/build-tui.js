const fs = require("fs");
const path = require("path");
const https = require("https");

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function fetchUrl(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400) {
          if (res.headers.location && redirectsLeft > 0) {
            const next = res.headers.location.startsWith("http")
              ? res.headers.location
              : new URL(res.headers.location, url).toString();
            res.resume();
            resolve(fetchUrl(next, redirectsLeft - 1));
            return;
          }
        }

        if (res.statusCode >= 400) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }

        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(data));
      })
      .on("error", reject);
  });
}

function extractItems(json) {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json && json.products)) return json.products;
  if (Array.isArray(json && json.items)) return json.items;
  if (Array.isArray(json && json.data)) return json.data;
  if (json && json.productFeed && Array.isArray(json.productFeed.products)) {
    return json.productFeed.products;
  }
  return [];
}

function first(val) {
  if (Array.isArray(val)) return val[0] || "";
  return val || "";
}

function toNumber(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s.replace(",", "."));
  if (Number.isFinite(n)) return n;
  return null;
}

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]+/g, "");
}

function pickBanner(p) {
  if (p && Array.isArray(p.images) && p.images.length) return p.images[0];
  if (p && p.image) return p.image;
  if (p && p.imageURL) return p.imageURL;
  if (p && p.imageUrl) return p.imageUrl;
  return "";
}

/**
 * Alleen pakketreizen met vlucht
 */
function transportTypesOf(p) {
  const a = [];

  if (p && Array.isArray(p.transportType)) a.push(...p.transportType);
  if (p && typeof p.transportType === "string") a.push(p.transportType);

  const props = p && p.properties ? p.properties : {};
  const pt = props.transportType;

  if (Array.isArray(pt)) a.push(...pt);
  if (typeof pt === "string") a.push(pt);

  return a
    .map((x) => String(x || "").trim().toUpperCase())
    .filter((x) => x.length > 0);
}

function isFlightOnly(p) {
  const t = transportTypesOf(p);
  return t.includes("VL");
}

(async () => {
  const url = process.env.TT_FEED_URL;
  if (!url) {
    console.error("Missing TT_FEED_URL");
    process.exit(1);
  }

  console.log("Downloading TUI feed...");
  const raw = await fetchUrl(url);

  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    console.error("Invalid JSON");
    process.exit(1);
  }

  const items = extractItems(json);
  console.log("Items (raw):", items.length);

  const flightItems = items.filter((p) => isFlightOnly(p));
  console.log("Items (transportType includes VL):", flightItems.length);

  const thin = flightItems
    .map((p) => {
      const props = p && p.properties ? p.properties : {};

      return {
        id: String(p.ID || p.id || "").trim(),
        title: String(p.name || p.title || "").trim(),
        price: toNumber((p.price && p.price.amount) || p.price),
        currency: String((p.price && p.price.currency) || "EUR").trim(),
        country: String(first(props.country) || p.country || "").trim(),
        departure: String(first(props.iataDeparture) || "").trim(),
        departureDate: String(first(props.departureDate) || "").trim(),
        duration: toNumber(first(props.duration)),
        stars: String(first(props.stars) || "").trim(),
        province: String(first(props.province) || "").trim(),
        region: String(first(props.region) || "").trim(),
        serviceType: String(first(props.serviceType) || "").trim(),
        url: String(p.URL || p.url || "").trim(),
        banner: pickBanner(p),
      };
    })
    .filter((x) => x && x.url)
    .filter((x) => x.title)
    .filter((x) => x.price !== null && x.price > 0)
    .filter((x) => x.departureDate)
    .filter((x) => x.duration !== null && x.duration > 0);

  thin.sort((a, b) => (a.price ?? 99999999) - (b.price ?? 99999999));

  const outBase = path.join(process.cwd(), "public", "tui");
  const outCountryDir = path.join(outBase, "country");

  ensureDir(outBase);
  ensureDir(outCountryDir);

  fs.writeFileSync(path.join(outBase, "all.min.json"), JSON.stringify(thin));

  const byCountry = {};
  thin.forEach((p) => {
    const c = p.country || "Onbekend";
    if (!byCountry[c]) byCountry[c] = [];
    byCountry[c].push(p);
  });

  const COUNTRY_PRICE_CAPS = {
    Spanje: 600,
    Griekenland: 650,
    Turkije: 700,
    Portugal: 650,
    Italië: 650,
    Egypte: 800,
    __default: 700,
  };

  const DEFAULT_CAP = COUNTRY_PRICE_CAPS.__default || 700;

  const index = {
    last_updated: new Date().toISOString(),
    caps: COUNTRY_PRICE_CAPS,
    countries: {},
    files: {
      all_min: "tui/all.min.json",
      country_index: "tui/country/index.json",
    },
  };

  for (const country in byCountry) {
    const cap = COUNTRY_PRICE_CAPS[country] ?? DEFAULT_CAP;

    const filtered = byCountry[country]
      .filter((x) => x.price !== null && x.price <= cap)
      .sort((a, b) => (a.price ?? 99999999) - (b.price ?? 99999999));

    const fileName = `${slugify(country)}_under_${cap}.json`;

    fs.writeFileSync(
      path.join(outCountryDir, fileName),
      JSON.stringify(filtered)
    );

    index.countries[country] = {
      cap,
      total: byCountry[country].length,
      under_cap: filtered.length,
      file: `tui/country/${fileName}`,
    };
  }

  fs.writeFileSync(
    path.join(outCountryDir, "index.json"),
    JSON.stringify(index, null, 2)
  );

  console.log("TUI feed build complete.");
})();
