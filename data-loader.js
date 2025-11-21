// World Bank Development Data Loader
// ---------------------------------
// This version loads the full World Bank dataset (1960–2020) from the
// `world-bank-data` folder (clone of
// https://github.com/light-and-salt/World-Bank-Data-by-Indicators).
//
// It exposes these globals used by `main-new.js`:
//   - regionalGDPData: { [year]: [{ region, gdp, population, color }] }
//   - healthData:      { [year]: [{ country, countryCode, year,
//                                   gdpPerCapita, lifeExpectancy,
//                                   population, region }] }
//   - top10Countries:  static list (for backwards compatibility)
//   - whenDataReady(): Promise that resolves once all CSVs are processed
//   - loadGDPData(), loadHealthData(year), getAllHealthYears()

// -------------------------
// Global data containers
// -------------------------
let regionalGDPData = {};  // by year → array of regional aggregates
let healthData = {};       // by year → array of country-level records

// Keep previous API surface for other modules
const top10Countries = {
  gdp: ['United States', 'China', 'Japan', 'Germany', 'India', 'United Kingdom', 'France', 'Brazil', 'Italy', 'Canada'],
  population: ['China', 'India', 'United States', 'Indonesia', 'Brazil', 'Pakistan', 'Nigeria', 'Bangladesh', 'Russia', 'Mexico'],
  life_expectancy: ['Japan', 'Switzerland', 'Singapore', 'Spain', 'Italy', 'Australia', 'France', 'South Korea', 'Canada', 'Norway']
};

// Reuse the small hand-authored coordinate set for the Mapbox demo
const countryCoordinates = {
  'United States': { lng: -95.7129, lat: 37.0902 },
  'China': { lng: 104.1954, lat: 35.8617 },
  'India': { lng: 78.9629, lat: 20.5937 },
  'Germany': { lng: 10.4515, lat: 51.1657 },
  'Brazil': { lng: -47.8825, lat: -14.2350 },
  'Nigeria': { lng: 8.6753, lat: 9.0820 }
};

// Region mapping from World Bank "Region" to our display regions
const REGION_NORMALIZATION = {
  'North America': 'North America',
  'Latin America & Caribbean': 'Latin America',
  'Europe & Central Asia': 'Europe',
  'East Asia & Pacific': 'East Asia',
  'South Asia': 'South Asia',
  'Sub-Saharan Africa': 'Africa',
  'Middle East & North Africa': 'Middle East'
};

const REGION_COLORS = {
  'North America': '#4e79a7',
  'Europe': '#f28e2c',
  'East Asia': '#e15759',
  'South Asia': '#76b7b2',
  'Africa': '#59a14f',
  'Latin America': '#edc949',
  'Middle East': '#af7aa1'
};

// -------------------------
// Helper utilities
// -------------------------
function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function yearInRange(year) {
  return year >= 1960 && year <= 2020;
}

// -------------------------
// Core loading routine
// -------------------------
let worldBankDataPromise = null;

async function loadWorldBankData() {
  if (worldBankDataPromise) return worldBankDataPromise;

  if (typeof d3 === 'undefined') {
    console.warn('d3 is not loaded; falling back to empty data structures.');
    regionalGDPData = {};
    healthData = {};
    worldBankDataPromise = Promise.resolve();
    return worldBankDataPromise;
  }

  worldBankDataPromise = (async () => {
    // Load CSVs in parallel
    const [
      economyRows,
      healthRows,
      socialRows,
      countryMetaRows
    ] = await Promise.all([
      d3.csv('world-bank-data/economy-and-growth/economy-and-growth.csv'),
      d3.csv('world-bank-data/health/health.csv'),
      d3.csv('world-bank-data/social-development/social-development.csv'),
      d3.csv('world-bank-data/economy-and-growth/Metadata_Country_API_3_DS2_en_csv_v2_3060949.csv')
    ]);

    // Country metadata: code → { region, name }
    const countryMetaByCode = {};
    countryMetaRows.forEach(row => {
      const code = row['Country Code'];
      if (!code) return;
      countryMetaByCode[code] = {
        region: row.Region || '',
        name: row.TableName || code
      };
    });

    // Population by (code, year) from health.csv
    const populationByKey = {}; // key: CODE_YEAR → population (absolute)
    healthRows.forEach(row => {
      const code = row['Country Code'];
      const year = toNumber(row['Year']);
      if (!code || !yearInRange(year)) return;

      const pop = toNumber(row['average_value_Population, total']);
      if (pop === null) return;

      const key = `${code}_${year}`;
      populationByKey[key] = pop;
    });

    // Life expectancy by (code, year) from social-development.csv
    const lifeExpByKey = {}; // CODE_YEAR → life expectancy (years)
    socialRows.forEach(row => {
      const code = row['Country Code'];
      const year = toNumber(row['Year']);
      if (!code || !yearInRange(year)) return;

      const female = toNumber(row['average_value_Life expectancy at birth, female (years)']);
      const male = toNumber(row['average_value_Life expectancy at birth, male (years)']);
      let life = null;
      if (female !== null && male !== null) {
        life = (female + male) / 2;
      } else if (female !== null) {
        life = female;
      } else if (male !== null) {
        life = male;
      }
      if (life === null) return;

      const key = `${code}_${year}`;
      lifeExpByKey[key] = life;
    });

    // GDP total + GDP per capita by (code, year) from economy-and-growth.csv
    const gdpTotalByKey = {};     // CODE_YEAR → GDP total (constant 2010 US$)
    const gdpPerCapitaByKey = {}; // CODE_YEAR → GDP per capita (constant 2010 US$)
    const countryNameByCode = {};

    economyRows.forEach(row => {
      const code = row['Country Code'];
      const year = toNumber(row['Year']);
      if (!code || !yearInRange(year)) return;

      const total = toNumber(row['average_value_GDP (constant 2010 US$)']);
      const perCapita = toNumber(row['average_value_GDP per capita (constant 2010 US$)']);
      if (total === null && perCapita === null) return;

      const key = `${code}_${year}`;
      if (total !== null) gdpTotalByKey[key] = total;
      if (perCapita !== null) gdpPerCapitaByKey[key] = perCapita;

      if (!countryNameByCode[code]) {
        countryNameByCode[code] = row['Country Name'] || code;
      }
    });

    // -------------------------
    // Build healthData (country-level panel)
    // -------------------------
    const healthTemp = {}; // by year

    Object.keys(gdpPerCapitaByKey).forEach(key => {
      const [code, yearStr] = key.split('_');
      const year = Number(yearStr);
      const pop = populationByKey[key];
      const life = lifeExpByKey[key];
      const gdpPerCapita = gdpPerCapitaByKey[key];

      if (!yearInRange(year) || pop == null || life == null || gdpPerCapita == null) return;

      const meta = countryMetaByCode[code] || {};
      const wbRegion = meta.region || '';
      const region = REGION_NORMALIZATION[wbRegion] || wbRegion || 'Other';
      const countryName = countryNameByCode[code] || meta.name || code;

      if (!healthTemp[year]) healthTemp[year] = [];
      healthTemp[year].push({
        country: countryName,
        countryCode: code,
        year,
        gdpPerCapita,
        lifeExpectancy: life,
        population: pop,
        region
      });
    });

    // Sort each year's health data by GDP per capita (descending)
    Object.keys(healthTemp).forEach(yearStr => {
      const year = Number(yearStr);
      healthTemp[year].sort((a, b) => b.gdpPerCapita - a.gdpPerCapita);
    });

    healthData = healthTemp;

    // -------------------------
    // Build regionalGDPData (region/year aggregates)
    // -------------------------
    const regionYearAgg = {}; // REGION_YEAR → { region, year, gdp, population }

    Object.keys(gdpTotalByKey).forEach(key => {
      const [code, yearStr] = key.split('_');
      const year = Number(yearStr);
      if (!yearInRange(year)) return;

      const meta = countryMetaByCode[code];
      if (!meta || !meta.region) return;

      const wbRegion = meta.region;
      const region = REGION_NORMALIZATION[wbRegion];
      if (!region) return; // skip aggregates/regions we don't map

      const regionKey = `${region}_${year}`;
      if (!regionYearAgg[regionKey]) {
        regionYearAgg[regionKey] = {
          region,
          year,
          gdp: 0,
          population: 0
        };
      }

      const agg = regionYearAgg[regionKey];
      const totalGDP = gdpTotalByKey[key];
      const pop = populationByKey[key];

      if (totalGDP != null) agg.gdp += totalGDP;
      if (pop != null) agg.population += pop;
    });

    const regionalTemp = {}; // year → array of regions
    Object.keys(regionYearAgg).forEach(k => {
      const { region, year, gdp, population } = regionYearAgg[k];
      if (!regionalTemp[year]) regionalTemp[year] = [];
      regionalTemp[year].push({
        region,
        // Convert to trillions of US$ and millions of people for nicer scales
        gdp: gdp / 1e12,
        population: population / 1e6,
        color: REGION_COLORS[region] || '#999999'
      });
    });

    // Ensure deterministic region ordering for each year
    Object.keys(regionalTemp).forEach(yearStr => {
      const year = Number(yearStr);
      regionalTemp[year].sort((a, b) => a.region.localeCompare(b.region));
    });

    regionalGDPData = regionalTemp;
  })();

  return worldBankDataPromise;
}

// -------------------------
// Public helper functions
// -------------------------

function whenDataReady() {
  // Kick off loading on first call
  return loadWorldBankData();
}

async function loadGDPData() {
  await whenDataReady();
  return regionalGDPData;
}

async function loadHealthData(year) {
  await whenDataReady();
  if (year != null && healthData[year]) {
    return healthData[year];
  }
  // Fallback to latest year with data
  const years = Object.keys(healthData).map(Number).sort((a, b) => a - b);
  return years.length ? healthData[years[years.length - 1]] : [];
}

async function getAllHealthYears() {
  await whenDataReady();
  return Object.keys(healthData).map(Number).sort((a, b) => a - b);
}

function getCountryCoordinates(countryName) {
  return countryCoordinates[countryName] || null;
}


