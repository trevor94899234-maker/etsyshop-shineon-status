import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SUMMARY_URL = 'https://status.shineon.com/v3/summary.json';
const COMPONENTS_URL = 'https://status.shineon.com/v3/components.json';
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(scriptDirectory, '../data/shineon-status.json');

async function fetchJson(url) {
  let response;

  try {
    response = await fetch(url, {
      headers: { accept: 'application/json' },
    });
  } catch (error) {
    throw new Error(`Request failed for ${url}: ${error.message}`);
  }

  if (response.status !== 200) {
    throw new Error(`Expected HTTP 200 from ${url}, received ${response.status} ${response.statusText}`);
  }

  try {
    return await response.json();
  } catch (error) {
    throw new Error(`Response from ${url} is not valid JSON: ${error.message}`);
  }
}

function requireObject(value, description) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid JSON shape: ${description} must be an object`);
  }
  return value;
}

function buildSnapshot(summaryResponse, componentsResponse) {
  const summary = requireObject(summaryResponse, 'summary response');
  const componentPayload = requireObject(componentsResponse, 'components response');

  const page = requireObject(summary.page, 'summary response page');
  if (!Object.hasOwn(page, 'status')) {
    throw new Error('Invalid JSON shape: summary response page does not provide status');
  }

  if (!Array.isArray(componentPayload.components)) {
    throw new Error('Invalid JSON shape: components response does not provide a components array');
  }

  const snapshot = {
    fetchedAt: new Date().toISOString(),
    sources: {
      summary: SUMMARY_URL,
      components: COMPONENTS_URL,
    },
    pageStatus: page.status,
    components: componentPayload.components.map((component, index) => {
      const rawComponent = requireObject(component, `components[${index}]`);
      return {
        name: rawComponent.name,
        status: rawComponent.status,
        group: rawComponent.group,
      };
    }),
  };

  // These fields are intentionally omitted when the API does not provide them.
  if (Object.hasOwn(summary, 'activeIncidents')) {
    snapshot.activeIncidents = summary.activeIncidents;
  }
  if (Object.hasOwn(summary, 'activeMaintenances')) {
    snapshot.activeMaintenances = summary.activeMaintenances;
  }

  return snapshot;
}

async function writeSnapshot(snapshot) {
  const outputDirectory = dirname(outputPath);
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;

  await mkdir(outputDirectory, { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, outputPath);
}

async function main() {
  // Do all network and validation work before touching the existing data file.
  const [summary, components] = await Promise.all([
    fetchJson(SUMMARY_URL),
    fetchJson(COMPONENTS_URL),
  ]);
  const snapshot = buildSnapshot(summary, components);

  await writeSnapshot(snapshot);

  const overallStatus = typeof snapshot.pageStatus === 'object' && snapshot.pageStatus !== null
    ? snapshot.pageStatus.description ?? snapshot.pageStatus.indicator ?? JSON.stringify(snapshot.pageStatus)
    : String(snapshot.pageStatus);
  console.log(`Success: fetched 2 APIs, ${snapshot.components.length} components, overall status: ${overallStatus}`);
}

main().catch((error) => {
  console.error(`Failed to fetch ShineOn status: ${error.message}`);
  process.exitCode = 1;
});
