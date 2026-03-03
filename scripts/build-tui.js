const fs = require("fs");
const path = require("path");
const https = require("https");

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function fetchUrl(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location &&
        redirectsLeft > 0
      ) {
        const next = res.headers.location.startsWith("http")
          ? res.headers.location
          : new URL(res.headers.location, url).toString();
        res.resume();
        return resolve(fetchUrl(next, redirectsLeft - 1));
      }

      if (res.statusCode >= 400) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(data));
    }).on("error", reject);
  });
}

function extractItems(json) {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.products)) return json.products;
  if (Array.isArray(json?.items)) return json.items;
  if (Array.isArray(json?.data)) return json.data;
  if (Array.isArray(json?.productFeed?.products)) return json.productFeed.products;
  return [];
}

function first(val) {
  if (Array.isArray(val)) return val[0] || "";
  return val || "";
}

function toNumber(v) {
  if (!v) return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]+/g, "");
}

function pickBanner(p) {
  if (Array.isArray(p?.images) && p.images.length) return p.images[0];
  if (p?.image) return p.image;
  if (p?.imageURL) return p.imageURL;
  if (p?.imageUrl) return p.imageUrl;
  return "";
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
  console.log("Items:", items.length);

  const thin = items
    .map((p) => {
      const props = p.properties || {};

      return {
        id: p.ID || p.id || "",
        title: p.name || p.title || "",
        price: toNumber(p?.price?.amount || p?.price),
        currency: p?.price?.currency || "EUR",
        country: first(props.country) || p.country || "",
        departure: first(props.iataDeparture) || "",
        departureDate: first(props.departureDate) || "",
        duration: toNumber(first(props.duration)),
        stars: first(props.stars) || "",
        province: first(props.province) || "",
        region: first(props.region) || "",
        serviceType: first(props.serviceType) || "",
        url: p.URL || p.url || "",
        banner: pickBanner(p),
      };
    })
    .filter((x) => x.url);

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
    Egypte: 800,
  };

  const DEFAULT_CAP = 700;

  for (const country in byCountry) {
    const cap = COUNTRY_PRICE_CAPS[country] ?? DEFAULT_CAP;

    const filtered = byCountry[country].filter(
      (x) => x.price !== null && x.price <= cap
    );

    const fileName = `${slugify(country)}_under_${cap}.json`;

    fs.writeFileSync(
      path.join(outCountryDir, fileName),
      JSON.stringify(filtered)
    );
  }

  console.log("TUI feed build complete.");
})();
