require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const path = require("path");

const app = express();
const port = Number.parseInt(process.env.PORT || "8080", 10);
let oauthTokenCache = {
  accessToken: "",
  expiresAtMs: 0,
};

const config = {
  username: process.env.DAYLIGHT_USERNAME,
  password: process.env.DAYLIGHT_PASSWORD,
  account: process.env.DAYLIGHT_ACCOUNT,
  apiKey: process.env.DAYLIGHT_API_KEY,
  apiSecret: process.env.DAYLIGHT_API_SECRET,
  baseUrl: process.env.DAYLIGHT_BASE_URL,
  endpoint: process.env.DAYLIGHT_TRACKING_ENDPOINT,
  probillEndpoint: process.env.DAYLIGHT_PROBILL_ENDPOINT || "/externalTrace/{probill}",
  httpMethod: (process.env.DAYLIGHT_HTTP_METHOD || "GET").toUpperCase(),
    authMode: (process.env.DAYLIGHT_AUTH_MODE || "BASIC").toUpperCase(),
    oauthTokenUrl:
      process.env.DAYLIGHT_OAUTH_TOKEN_URL ||
      "https://api.dylt.com/oauth/client_credential/accesstoken",
    oauthScope: process.env.DAYLIGHT_OAUTH_SCOPE || "read:ship",
  bookingQueryParam: process.env.DAYLIGHT_BOOKING_QUERY_PARAM || "bookingNumber",
  accountQueryParam: process.env.DAYLIGHT_ACCOUNT_QUERY_PARAM || "",
  accountHeader: process.env.DAYLIGHT_ACCOUNT_HEADER || "x-account-number",
  apiKeyHeader: process.env.DAYLIGHT_API_KEY_HEADER || "x-api-key",
  apiSecretHeader: process.env.DAYLIGHT_API_SECRET_HEADER || "x-api-secret",
  timeoutMs: Number.parseInt(process.env.DAYLIGHT_TIMEOUT_MS || "15000", 10),
};

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (req, res) => {
  const missing = requiredConfigKeys().filter((key) => !config[key]);
  res.json({
    ok: missing.length === 0,
    missing,
    endpointConfigured: isRealEndpointConfigured(),
    endpointPreview: config.endpoint || "",
  });
});

app.get("/api/daylight/debug/:bookingNumber", async (req, res) => {
  const bookingNumber = String(req.params.bookingNumber || "").trim();

  if (!bookingNumber) {
    return res.status(400).json({
      message: "bookingNumber is required.",
    });
  }

  const missing = requiredConfigKeys().filter((key) => !config[key]);
  if (missing.length > 0) {
    return res.status(500).json({
      message: "Server configuration is incomplete.",
      missing,
    });
  }

  if (!isRealEndpointConfigured()) {
    return res.status(500).json({
      message: "DAYLIGHT_TRACKING_ENDPOINT is still placeholder.",
      endpoint: config.endpoint,
    });
  }

  try {
    const result = await fetchBookingDetailsWithDebug(bookingNumber);
    return res.json(result);
  } catch (error) {
    const details = extractAxiosError(error);
    return res.status(502).json({
      message: "Daylight API request failed.",
      details,
    });
  }
});

app.post("/api/daylight/query", async (req, res) => {
  const references = normalizeBookingNumbers(req.body?.bookingNumbers);

  if (references.length === 0) {
    return res.status(400).json({
      message: "Please provide at least one booking or probill number.",
    });
  }

  if (references.length > 100) {
    return res.status(400).json({
      message: "Please query 100 booking numbers or fewer per request.",
    });
  }

  const missing = requiredConfigKeys().filter((key) => !config[key]);
  if (missing.length > 0) {
    return res.status(500).json({
      message: "Server configuration is incomplete.",
      missing,
    });
  }

  if (!isRealEndpointConfigured()) {
    return res.status(500).json({
      message: "DAYLIGHT_TRACKING_ENDPOINT is not configured. Replace placeholder in .env.",
      endpoint: config.endpoint,
    });
  }

  try {
    const records = await Promise.all(
      references.map((reference) => fetchBookingDetails(reference))
    );

    return res.json({
      requested: references.length,
      returned: records.length,
      records,
    });
  } catch (error) {
    const details = extractAxiosError(error);
    return res.status(502).json({
      message: "Daylight API request failed.",
      details,
    });
  }
});

app.get("/*splat", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Daylight Sync app is running on http://localhost:${port}`);
});

function requiredConfigKeys() {
  return [
    "username",
    "password",
    "account",
    "apiKey",
    "apiSecret",
    "baseUrl",
    "endpoint",
  ];
}

function normalizeBookingNumbers(input) {
  if (!input) {
    return [];
  }

  const raw = Array.isArray(input) ? input.join("\n") : String(input);
  return [...new Set(raw
    .split(/[\n,;\s]+/)
    .map((item) => item.trim())
    .filter(Boolean))];
}

async function fetchBookingDetails(bookingNumber) {
  const result = await fetchBookingDetailsWithDebug(bookingNumber);
  return result.normalized;
}

async function fetchBookingDetailsWithDebug(inputReference) {
  const strategies = buildLookupStrategies(inputReference);
  let fallbackResult = null;
  let lastError = null;

  for (const strategy of strategies) {
    try {
      const responseResult = await fetchSingleReferenceDetails(strategy);
      const normalized = {
        ...responseResult.normalized,
        inputReference,
      };

      if (strategy.lookupValue !== inputReference) {
        normalized.matchedReferenceValue = strategy.lookupValue;
      }
      normalized.matchType = strategy.type;

      const result = {
        ...responseResult,
        bookingNumber: inputReference,
        normalized,
      };

      if (isMeaningfulBookingResult(normalized)) {
        return result;
      }

      if (!fallbackResult) {
        fallbackResult = result;
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (fallbackResult) {
    return fallbackResult;
  }

  throw lastError || new Error("Unable to query booking details.");
}

async function fetchSingleReferenceDetails(strategy) {
  const url = buildUrl(strategy.endpointTemplate, strategy.pathToken, strategy.lookupValue);
  const headers = await buildHeaders();
  const method = config.httpMethod;
  const usesPathParam = strategy.endpointTemplate.includes(`{${strategy.pathToken}}`);

  if (method === "POST") {
    const payload = {
      [strategy.queryParam]: strategy.lookupValue,
      [strategy.pathToken]: strategy.lookupValue,
      account: config.account,
    };

    const response = await axios.post(url, payload, {
      headers,
      timeout: config.timeoutMs,
    });

    return {
      bookingNumber: strategy.lookupValue,
      request: {
        method,
        url,
        query: null,
        payload,
      },
      raw: response.data,
      normalized: normalizeApiRecord(strategy, response.data),
    };
  }

  const query = {};

  if (!usesPathParam) {
    query[strategy.queryParam] = strategy.lookupValue;
  }

  if (strategy.includeAccountQuery && config.accountQueryParam) {
    query[config.accountQueryParam] = config.account;
  }

  const response = await axios.get(url, {
    headers,
    params: query,
    timeout: config.timeoutMs,
  });

  return {
    bookingNumber: strategy.lookupValue,
    request: {
      method,
      url,
      query,
      payload: null,
    },
    raw: response.data,
    normalized: normalizeApiRecord(strategy, response.data),
  };
}

function buildLookupStrategies(inputReference) {
  const value = String(inputReference || "").trim();
  const bookingCandidates = bookingNumberCandidates(value);
  const probillCandidates = probillCandidatesFromInput(value);

  const bookingStrategies = bookingCandidates.map((lookupValue) => ({
    type: "booking",
    lookupValue,
    endpointTemplate: config.endpoint,
    pathToken: "bookingNumber",
    queryParam: config.bookingQueryParam,
    includeAccountQuery: true,
  }));

  const probillStrategies = probillCandidates.map((lookupValue) => ({
    type: "probill",
    lookupValue,
    endpointTemplate: config.probillEndpoint,
    pathToken: "probill",
    queryParam: "probill",
    includeAccountQuery: false,
  }));

  return [...bookingStrategies, ...probillStrategies];
}

function bookingNumberCandidates(bookingNumber) {
  const value = String(bookingNumber || "").trim();
  if (!value) {
    return [];
  }

  if (/b$/i.test(value)) {
    return [value, value.slice(0, -1)];
  }

  return [value, `${value}B`];
}

function probillCandidatesFromInput(inputReference) {
  const value = String(inputReference || "").trim();
  if (!value) {
    return [];
  }

  const withoutB = value.replace(/b$/i, "");
  return [...new Set([value, withoutB].filter(Boolean))];
}

function isMeaningfulBookingResult(record) {
  if (!record || typeof record !== "object") {
    return false;
  }

  return Boolean(
    record.proNumber ||
    (record.status && record.status !== "Unknown") ||
    record.shippingLocation ||
    record.consignee ||
    (Array.isArray(record.stations) && record.stations.length > 0)
  );
}

async function buildHeaders() {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  if (config.authMode === "OAUTH2_CLIENT_CREDENTIALS") {
    const accessToken = await getOAuthAccessToken();
    headers.Authorization = `Bearer ${accessToken}`;
  } else {
    const auth = Buffer.from(`${config.username}:${config.password}`).toString("base64");
    headers.Authorization = `Basic ${auth}`;
    headers[config.apiKeyHeader] = config.apiKey;
    headers[config.apiSecretHeader] = config.apiSecret;
  }

  if (config.accountHeader && config.account) {
    headers[config.accountHeader] = config.account;
  }

  return headers;
}

function buildUrl(endpointTemplate, pathToken, lookupValue) {
  const baseUrl = config.baseUrl.replace(/\/$/, "");
  const endpoint = endpointTemplate.startsWith("/")
    ? endpointTemplate
    : `/${endpointTemplate}`;

  if (endpoint.includes(`{${pathToken}}`)) {
    return `${baseUrl}${endpoint.replace(`{${pathToken}}`, encodeURIComponent(lookupValue))}`;
  }

  return `${baseUrl}${endpoint}`;
}

function normalizeApiRecord(strategy, data) {
  const source = unwrapData(data);
  const normalizedStations = resolveStations(source);
  const bookingFromRefs = extractBookingNumberFromReferences(source);

  const proNumber = firstValue(source, [
    "billNumber",
    "pro",
    "proNumber",
    "proNo",
    "proNbr",
    "pro_number",
    "PRO",
  ]) || "";

  const status = firstValue(source, [
    "status",
    "currentStatus",
    "shipmentStatus",
    "state",
    "latestStatus",
  ]) || "Unknown";

  const shippingLocation = firstValue(source, [
    "termId",
    "shippingLocation",
    "currentLocation",
    "location",
    "origin",
    "lastKnownLocation",
  ]) || deriveLatestStationLocation(normalizedStations) || deriveAddressLocation(source);

  const consignee = resolveConsignee(source);
  const stations = normalizedStations;

  const bookingNumber =
    firstValue(source, ["bookingNumber", "bookingNbr"]) ||
    bookingFromRefs ||
    (strategy.type === "booking" ? strategy.lookupValue : "");

  const resolvedProNumber =
    proNumber ||
    (strategy.type === "probill" ? strategy.lookupValue : "");

  return {
    bookingNumber,
    proNumber: resolvedProNumber,
    status,
    shippingLocation,
    consignee,
    stations,
    raw: source,
  };
}

function unwrapData(data) {
  // Some endpoints wrap payload in a stringified JSON object.
  if (typeof data === "string") {
    try {
      return JSON.parse(data);
    } catch (_error) {
      return {};
    }
  }

  if (!data || typeof data !== "object") {
    return {};
  }

  const candidates = [
    data.externalTraceResp,
    data,
    data.data,
    data.result,
    data.response,
    data.shipment,
    data.shipments,
    data.items,
  ];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    if (Array.isArray(candidate) && candidate.length > 0 && typeof candidate[0] === "object") {
      return candidate[0];
    }

    if (!Array.isArray(candidate) && typeof candidate === "object") {
      return candidate;
    }
  }

  return {};
}

function resolveConsignee(source) {
  if (!source || typeof source !== "object") {
    return "";
  }

  if (typeof source.consignee === "string") {
    return source.consignee;
  }

  if (source.consignee && typeof source.consignee === "object") {
    return (
      source.consignee.name ||
      source.consignee.company ||
      source.consignee.customerName ||
      ""
    );
  }

  return firstValue(source, ["consigneeName", "receiver", "customerName"]) || "";
}

function resolveStations(source) {
  const stations =
    source?.statHistArr ||
    source?.stations ||
    source?.events ||
    source?.stops ||
    source?.route ||
    source?.movementHistory ||
    [];

  if (!Array.isArray(stations)) {
    return [];
  }

  return stations.map((station, index) => ({
    step: index + 1,
    name:
      station.termId ||
      station.station ||
      station.name ||
      station.code ||
      station.event ||
      `Station ${index + 1}`,
    city: station.city || station.town || "",
    state: station.state || station.province || "",
    status: station.status || station.eventStatus || station.description || "",
    eta: station.date || station.eta || station.estimatedArrival || station.timestamp || "",
    raw: station,
  }));
}

function firstValue(source, keys) {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value);
    }
  }

  return "";
}

function extractBookingNumberFromReferences(source) {
  const references = source?.shipReferences?.shipReference;
  if (!references) {
    return "";
  }

  const list = Array.isArray(references) ? references : [references];
  const bookingRef = list.find((item) => String(item?.referenceType || "").toUpperCase() === "K");

  if (!bookingRef?.referenceNumber) {
    return "";
  }

  return String(bookingRef.referenceNumber);
}

function extractAxiosError(error) {
  if (!error) {
    return { message: "Unknown error" };
  }

  if (error.response) {
    return {
      status: error.response.status,
      statusText: error.response.statusText,
      data: error.response.data,
    };
  }

  return {
    message: error.message,
  };
}

async function getOAuthAccessToken() {
  const now = Date.now();
  const refreshBufferMs = 60 * 1000;
  if (oauthTokenCache.accessToken && oauthTokenCache.expiresAtMs - refreshBufferMs > now) {
    return oauthTokenCache.accessToken;
  }

  const basicCreds = Buffer.from(`${config.apiKey}:${config.apiSecret}`).toString("base64");
  const params = new URLSearchParams();
  params.set("grant_type", "client_credentials");
  if (config.oauthScope) {
    params.set("scope", config.oauthScope);
  }

  const tokenUrl = new URL(config.oauthTokenUrl);
  if (!tokenUrl.searchParams.has("grant_type")) {
    tokenUrl.searchParams.set("grant_type", "client_credentials");
  }

  const response = await axios.post(tokenUrl.toString(), params.toString(), {
    headers: {
      Authorization: `Basic ${basicCreds}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    timeout: config.timeoutMs,
  });

  const accessToken = response?.data?.access_token || response?.data?.token;
  const expiresInSeconds = Number(response?.data?.expires_in || 3600);

  if (!accessToken) {
    throw new Error("OAuth token response did not include access_token.");
  }

  oauthTokenCache = {
    accessToken,
    expiresAtMs: Date.now() + expiresInSeconds * 1000,
  };

  return accessToken;
}

function deriveLatestStationLocation(stations) {
  if (!Array.isArray(stations) || stations.length === 0) {
    return "";
  }

  const latest = stations[stations.length - 1];
  const cityState = [latest.city, latest.state].filter(Boolean).join(", ");
  return cityState || latest.name || "";
}

function deriveAddressLocation(source) {
  const consigneeCityState = [source?.consigneeCity, source?.consigneeState].filter(Boolean).join(", ");
  if (consigneeCityState) {
    return consigneeCityState;
  }

  const shipperCityState = [source?.shipperCity, source?.shipperState].filter(Boolean).join(", ");
  return shipperCityState;
}

function isRealEndpointConfigured() {
  if (!config.endpoint) {
    return false;
  }

  return config.endpoint !== "/replace-with-your-endpoint";
}
