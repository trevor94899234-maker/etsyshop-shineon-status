import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_PATH = resolve(PROJECT_DIR, 'data/product-status.json');
const TEMP_PATH = `${DATA_PATH}.tmp`;

const PRODUCTION_URL = 'https://teamshineon.zendesk.com/hc/en-us/articles/10262194743441-Production-and-Sync-Timescales-Info';
const PRODUCTION_FETCH_URL = 'https://teamshineon.zendesk.com/api/v2/help_center/en-us/articles/10262194743441.json';
const SHIPPING_URL = 'https://teamshineon.zendesk.com/hc/en-us/articles/10281047558545-Shipping-Timescales-Prices-Info#Variable';
const SHIPPING_FETCH_URL = 'https://teamshineon.zendesk.com/api/v2/help_center/en-us/articles/10281047558545.json';
const PRICES_SHEET_URL = 'https://docs.google.com/spreadsheets/d/1RapLC3WTjaDLePDZszpRh8SzBj0SNzhiTtySueTOpvE/edit?gid=170660766#gid=170660766';
const PRICES_CSV_URL = 'https://docs.google.com/spreadsheets/d/1RapLC3WTjaDLePDZszpRh8SzBj0SNzhiTtySueTOpvE/export?format=csv&gid=170660766';
const STATUS_SUMMARY_URL = 'https://status.shineon.com/v3/summary.json';
const STATUS_COMPONENTS_URL = 'https://status.shineon.com/v3/components.json';

const SUBSCRIPTION_COLUMNS = ['Empire Builder', 'Side-Hustle', 'Starter', 'Free'];
const SHIPPING_COLUMNS = ['USA Standard', 'USA Priority', 'CA Standard', 'CA Priority', 'EU Standard', 'EU Priority'];
const SHIPPING_TIMES = {
  'USA Standard': '2-5 business days',
  'USA Priority': '1-2 business days',
  'CA Standard': '4-8 business days',
  'CA Priority': '2-5 business days',
  'EU Standard': '3-10 business days',
  'EU Priority': '2-5 business days',
};

function cleanText(value) {
  return String(value ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function findRequiredText(text, pattern, label) {
  const match = text.match(pattern);
  if (!match) {
    throw new Error(`${label}: expected source wording was not found`);
  }
  return match[0].replace(/\s+/g, ' ').trim();
}

async function fetchText(url, label) {
  let response;
  try {
    response = await fetch(url, {
      headers: {
        'user-agent': 'etsyshop-product-change-monitor/1.0',
        accept: 'text/html,text/csv;q=0.9,*/*;q=0.8',
      },
    });
  } catch (error) {
    throw new Error(`${label}: request failed: ${error.message}`);
  }

  if (response.status !== 200) {
    throw new Error(`${label}: expected HTTP 200, received ${response.status}`);
  }

  const body = await response.text();
  if (!body.trim()) {
    throw new Error(`${label}: response body was empty`);
  }
  return body;
}

async function fetchZendeskArticle(apiUrl, label) {
  const raw = await fetchText(apiUrl, label);
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label}: response was not valid JSON: ${error.message}`);
  }
  if (!payload.article || typeof payload.article.body !== 'string') {
    throw new Error(`${label}: JSON did not contain article.body`);
  }
  return {
    body: payload.article.body,
    updatedAt: payload.article.updated_at ?? null,
  };
}

async function fetchJson(url, label) {
  const raw = await fetchText(url, label);
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label}: response was not valid JSON: ${error.message}`);
  }
}

function requireObject(value, description) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${description}: expected a JSON object`);
  }
  return value;
}

function buildStatusSnapshot(summaryResponse, componentsResponse) {
  const summary = requireObject(summaryResponse, 'Status summary response');
  const componentPayload = requireObject(componentsResponse, 'Status components response');
  const page = requireObject(summary.page, 'Status summary page');
  if (!Object.hasOwn(page, 'status')) {
    throw new Error('Status summary response: page.status was not provided');
  }
  if (!Array.isArray(componentPayload.components)) {
    throw new Error('Status components response: components array was not provided');
  }

  const status = {
    fetchedAt: new Date().toISOString(),
    sources: {
      summary: STATUS_SUMMARY_URL,
      components: STATUS_COMPONENTS_URL,
    },
    pageStatus: page.status,
    components: componentPayload.components.map((component, index) => {
      const rawComponent = requireObject(component, `Status components[${index}]`);
      return {
        name: rawComponent.name ?? null,
        status: rawComponent.status ?? null,
        group: rawComponent.group ?? null,
      };
    }),
  };

  // Keep absent optional fields absent: missing is different from an explicit zero.
  if (Object.hasOwn(summary, 'activeIncidents')) status.activeIncidents = summary.activeIncidents;
  if (Object.hasOwn(summary, 'activeMaintenances')) status.activeMaintenances = summary.activeMaintenances;
  return status;
}

function parseCsv(input) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const text = input.replace(/^\uFEFF/, '');

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];

    if (character === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (character === ',' && !inQuotes) {
      row.push(field);
      field = '';
    } else if ((character === '\n' || character === '\r') && !inQuotes) {
      if (character === '\r' && next === '\n') {
        index += 1;
      }
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function getProductFamily(productName) {
  if (productName === 'Graphic Journal') return 'Journal';
  if (/\bacrylic\b.*\bplaque\b/i.test(productName)) return 'Acrylic Plaque';
  return null;
}

function parseProductionSource(html) {
  const text = cleanText(html);
  const journalBasis = findRequiredText(
    text,
    /Leather Products\s*\(Graphic Journal, Leather Wallet\)\s*:\s*2-3 Business Days/i,
    'Production source / Graphic Journal',
  );
  const acrylicBasis = findRequiredText(
    text,
    /Acrylic Products\s*:\s*3-5 Business day[s]?/i,
    'Production source / Acrylic Products',
  );

  return {
    Journal: {
      range: '2-3 business days',
      basis: journalBasis,
      source: PRODUCTION_URL,
    },
    'Acrylic Plaque': {
      range: '3-5 business days',
      basis: acrylicBasis,
      source: PRODUCTION_URL,
    },
  };
}

function parseShippingSource(html) {
  const text = cleanText(html);
  const requiredPatterns = [
    /USA Standard\s*:\s*2-5 Days/i,
    /USA Priority\s*:\s*1-2 Days/i,
    /Canada Standard\s*:\s*4-8 Business Days/i,
    /Canada Priority\s*:\s*2-5 Business Days/i,
    /International Standard\s*:\s*3-10 Business Days/i,
    /International Priority\s*\(select countries\)\s*:\s*2-5 Business Days/i,
    /Ambassador Bound Journal\s*:\s*\$6\.55/i,
  ];

  for (const pattern of requiredPatterns) {
    findRequiredText(text, pattern, 'Shipping source');
  }

  return {
    times: SHIPPING_TIMES,
    variableReference: {
      product: 'Ambassador Bound Journal',
      price: '$6.55',
      source: SHIPPING_URL,
    },
    source: SHIPPING_URL,
    note: 'EU labels in the prices sheet are matched to the article’s International Standard/Priority times.',
  };
}

function parsePricesSheet(csv) {
  const rows = parseCsv(csv);
  const headerIndex = rows.findIndex((row) => row.includes('Empire Builder') && row.includes('USA Standard'));
  if (headerIndex < 0) {
    throw new Error('Prices sheet: subscription/shipping header row was not found');
  }

  const headers = rows[headerIndex].map((value) => value.trim());
  const columnIndex = new Map(headers.map((header, index) => [header, index]));
  const productIndex = columnIndex.get('');
  const nameIndex = productIndex === undefined ? 0 : productIndex;
  const products = [];

  for (const row of rows.slice(headerIndex + 1)) {
    const productName = String(row[nameIndex] ?? '').trim();
    const family = getProductFamily(productName);
    if (!family) continue;

    const pricing = {};
    for (const column of SUBSCRIPTION_COLUMNS) {
      pricing[column] = String(row[columnIndex.get(column)] ?? '').trim() || null;
    }

    const shipping = {};
    for (const column of SHIPPING_COLUMNS) {
      shipping[column] = String(row[columnIndex.get(column)] ?? '').trim() || null;
    }

    products.push({
      productKey: slugify(productName),
      productName,
      family,
      pricing,
      shipping,
      sourceRow: rows.indexOf(row) + 1,
    });
  }

  if (products.length === 0) {
    throw new Error('Prices sheet: no Graphic Journal or Acrylic Plaque rows were found');
  }
  return products;
}

function addEnrichment(products, production, shipping) {
  return products.map((product) => ({
    productKey: product.productKey,
    productName: product.productName,
    family: product.family,
    pricing: product.pricing,
    shipping: Object.fromEntries(
      SHIPPING_COLUMNS.map((region) => [region, {
        price: product.shipping[region],
        time: shipping.times[region],
      }]),
    ),
    production: production[product.family],
    sources: {
      prices: PRICES_SHEET_URL,
      production: PRODUCTION_URL,
      shipping: SHIPPING_URL,
    },
    sourceRow: product.sourceRow,
  }));
}

function comparableEntries(product) {
  const entries = [];
  for (const column of SUBSCRIPTION_COLUMNS) {
    entries.push({
      field: `pricing.${column}`,
      label: `${column} product cost`,
      value: product.pricing[column],
    });
  }
  for (const region of SHIPPING_COLUMNS) {
    entries.push({
      field: `shipping.${region}.price`,
      label: `${region} shipping price`,
      value: product.shipping[region]?.price ?? null,
    });
    entries.push({
      field: `shipping.${region}.time`,
      label: `${region} shipping time`,
      value: product.shipping[region]?.time ?? null,
    });
  }
  entries.push({
    field: 'production.range',
    label: 'production time',
    value: product.production?.range ?? null,
  });
  return entries;
}

function compareProducts(currentProducts, previousSnapshot) {
  if (!previousSnapshot) {
    return { comparisonStatus: 'baseline', previousFetchedAt: null, changes: [] };
  }

  const previousByKey = new Map((previousSnapshot.products ?? []).map((product) => [product.productKey, product]));
  const changes = [];

  for (const product of currentProducts) {
    const previous = previousByKey.get(product.productKey);
    if (!previous) {
      changes.push({
        productKey: product.productKey,
        productName: product.productName,
        family: product.family,
        field: '__product__',
        label: 'new product row',
        previous: null,
        current: product.productName,
        direction: 'new',
      });
      continue;
    }

    const previousEntries = new Map(comparableEntries(previous).map((entry) => [entry.field, entry.value]));
    for (const entry of comparableEntries(product)) {
      const previousValue = previousEntries.get(entry.field) ?? null;
      if (previousValue === entry.value) continue;
      changes.push({
        productKey: product.productKey,
        productName: product.productName,
        family: product.family,
        field: entry.field,
        label: entry.label,
        previous: previousValue,
        current: entry.value,
        direction: entry.value === null ? 'missing' : previousValue === null ? 'provided' : 'changed',
      });
    }
  }

  return {
    comparisonStatus: 'compared',
    previousFetchedAt: previousSnapshot.fetchedAt ?? null,
    changes,
  };
}

function stableValue(value) {
  if (value === undefined) return '__FIELD_NOT_PROVIDED__';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function compareStatus(currentStatus, previousStatus) {
  if (!previousStatus) {
    return { comparisonStatus: 'baseline', previousFetchedAt: null, changes: [] };
  }

  const changes = [];
  const addChange = (field, label, previous, current, direction = 'changed') => {
    if (stableValue(previous) === stableValue(current)) return;
    changes.push({ field, label, previous: previous ?? null, current: current ?? null, direction });
  };

  addChange('pageStatus', 'overall status', previousStatus.pageStatus, currentStatus.pageStatus);

  const previousComponents = new Map((previousStatus.components ?? []).map((component) => [component.name, component]));
  for (const component of currentStatus.components ?? []) {
    const previous = previousComponents.get(component.name);
    if (!previous) {
      addChange(`components.${component.name}`, `${component.name} status`, undefined, component.status, 'provided');
      continue;
    }
    addChange(`components.${component.name}.status`, `${component.name} status`, previous.status, component.status);
    addChange(`components.${component.name}.group`, `${component.name} group`, previous.group, component.group);
  }

  for (const field of ['activeIncidents', 'activeMaintenances']) {
    const previousProvided = Object.hasOwn(previousStatus, field);
    const currentProvided = Object.hasOwn(currentStatus, field);
    if (!previousProvided && !currentProvided) continue;
    const label = field === 'activeIncidents' ? 'active incidents' : 'active maintenances';
    if (!previousProvided && currentProvided) {
      addChange(field, label, undefined, currentStatus[field], 'provided');
    } else if (previousProvided && !currentProvided) {
      addChange(field, label, previousStatus[field], undefined, 'missing');
    } else {
      addChange(field, label, previousStatus[field], currentStatus[field]);
    }
  }

  return {
    comparisonStatus: 'compared',
    previousFetchedAt: previousStatus.fetchedAt ?? null,
    changes,
  };
}

async function readPreviousSnapshot() {
  try {
    const raw = await readFile(DATA_PATH, 'utf8');
    const snapshot = JSON.parse(raw);
    if (!snapshot || !Array.isArray(snapshot.products)) {
      throw new Error('existing snapshot does not contain a products array');
    }
    return snapshot;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Existing snapshot cannot be read safely: ${error.message}`);
  }
}

async function writeSnapshot(snapshot) {
  await mkdir(dirname(DATA_PATH), { recursive: true });
  await writeFile(TEMP_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  await rename(TEMP_PATH, DATA_PATH);
}

async function main() {
  try {
    const [statusSummary, statusComponents, productionArticle, shippingArticle, pricesCsv] = await Promise.all([
      fetchJson(STATUS_SUMMARY_URL, 'ShineOn status summary API'),
      fetchJson(STATUS_COMPONENTS_URL, 'ShineOn status components API'),
      fetchZendeskArticle(PRODUCTION_FETCH_URL, 'Production article'),
      fetchZendeskArticle(SHIPPING_FETCH_URL, 'Shipping article'),
      fetchText(PRICES_CSV_URL, 'Prices sheet CSV'),
    ]);

    const status = buildStatusSnapshot(statusSummary, statusComponents);
    const production = parseProductionSource(productionArticle.body);
    const shipping = parseShippingSource(shippingArticle.body);
    const products = addEnrichment(parsePricesSheet(pricesCsv), production, shipping);
    const previousSnapshot = await readPreviousSnapshot();
    const comparison = compareProducts(products, previousSnapshot);
    const statusComparison = compareStatus(status, previousSnapshot?.status);

    const snapshot = {
      fetchedAt: new Date().toISOString(),
      comparisonStatus: comparison.comparisonStatus,
      previousFetchedAt: comparison.previousFetchedAt,
      status,
      statusComparisonStatus: statusComparison.comparisonStatus,
      statusPreviousFetchedAt: statusComparison.previousFetchedAt,
      sources: {
        statusSummary: STATUS_SUMMARY_URL,
        statusComponents: STATUS_COMPONENTS_URL,
        production: PRODUCTION_URL,
        shipping: SHIPPING_URL,
        productionFetch: PRODUCTION_FETCH_URL,
        shippingFetch: SHIPPING_FETCH_URL,
        pricesSheet: PRICES_SHEET_URL,
        pricesCsv: PRICES_CSV_URL,
      },
      sourceNotes: {
        status: 'ShineOn status is read from the public summary and components APIs. Optional incident and maintenance fields remain absent when the API does not provide them.',
        pricing: 'Subscription product costs and region shipping prices are read from the supplied Google Sheet.',
        production: 'Journal and acrylic production ranges are category-level ranges from the supplied ShineOn article.',
        shipping: shipping.note,
      },
      products,
      changes: comparison.changes,
      statusChanges: statusComparison.changes,
    };

    await writeSnapshot(snapshot);
    const families = new Set(products.map((product) => product.family));
    const overallStatus = typeof status.pageStatus === 'object' && status.pageStatus !== null
      ? status.pageStatus.description ?? status.pageStatus.indicator ?? JSON.stringify(status.pageStatus)
      : String(status.pageStatus);
    console.log(`Success: fetched 5 sources, tracked ${products.length} product variants across ${families.size} families, detected ${comparison.changes.length} product changes (${comparison.comparisonStatus}); ShineOn status: ${overallStatus}; status updates: ${statusComparison.changes.length}.`);
  } catch (error) {
    console.error(`Product monitor failed: ${error.message}`);
    console.error('Existing data/product-status.json was not replaced.');
    process.exitCode = 1;
  }
}

await main();
