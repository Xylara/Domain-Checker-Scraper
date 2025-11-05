import puppeteer from "puppeteer";
import fs from 'fs/promises';
import { ProxyAgent } from 'undici';

const START_PAGE = 1;
const END_PAGE = 225;
const BASE_URL = "https://freedns.afraid.org/domain/registry/?page=";
const API_KEY = "onEkoztnFpTi3VG7XQEq6skQWN3aFm3h";
const UNBLOCKED_CATEGORY_NUMBERS = [6, 9, 10, 14, 15, 18, 20, 29, 30, 36, 37, 40, 41, 43, 44, 45, 46, 47, 48, 49, 50, 51, 57, 58, 59, 69, 73, 75, 76, 77, 79, 83, 84, 85, 99, 129, 131, 132, 139, 140, 900];
const OUTPUT_FILE = 'unblocked_domains.txt';
const PROXY_FILE = 'proxies.txt';
const CATEGORIZATION_API_URL = "https://production-archive-proxy-api.lightspeedsystems.com/archiveproxy";

let unblockedCount = 0;

let proxies = [];
let currentProxyIndex = 0;

async function loadProxies() {
    try {
        const data = await fs.readFile(PROXY_FILE, 'utf-8');
        proxies = data.split('\n')
                      .map(line => line.trim())
                      .filter(line => line.length > 0);

        if (proxies.length === 0) {
            console.error(`[FATAL] No proxies found in ${PROXY_FILE}. Exiting.`);
            process.exit(1);
        }
        console.log(`Loaded ${proxies.length} proxies.`);
    } catch (error) {
        console.error(`[FATAL] Could not read proxy file ${PROXY_FILE}:`, error.message);
        process.exit(1);
    }
}

function getCurrentProxy() {
    if (proxies.length === 0) {
        return null;
    }
    return `http://${proxies[currentProxyIndex]}`;
}

function rotateProxy() {
    currentProxyIndex++;
    if (currentProxyIndex >= proxies.length) {
        console.error("[FATAL] All proxies exhausted. Cannot continue.");
        return false;
    }
    console.log(`[INFO] Rotating to next proxy: ${getCurrentProxy()}`);
    return true;
}
async function appendDomainToFile(domain) {
    try {
        await fs.appendFile(OUTPUT_FILE, domain + '\n');
    } catch (error) {
        console.error(`[ERROR] Failed to write domain ${domain} to file:`, error.message);
    }
}
async function checkDomain(url) {
    while (true) {
        const proxyUrl = getCurrentProxy();
        if (!proxyUrl) {
            console.error(`[FATAL] No proxy available to check ${url}.`);
            return true;
        }

        const proxyAgent = new ProxyAgent(proxyUrl);

        try {
            const response = await fetch(
                CATEGORIZATION_API_URL,
                {
                    method: "POST",
                    body: JSON.stringify({
                        query:
                            "query getDeviceCategorization($itemA: CustomHostLookupInput!, $itemB: CustomHostLookupInput!){ a: custom_HostLookup(item: $itemA) {cat}  b: custom_HostLookup(item: $itemB) {cat}}",
                        variables: {
                            itemA: { hostname: url },
                            itemB: { hostname: url },
                        },
                    }),
                    headers: {
                        "Content-Type": "application/json",
                        "x-api-key": API_KEY,
                    },
                    agent: proxyAgent,
                }
            );

            if (!response.ok) {
                if (response.status === 429) {
                    console.warn(`[WARN] Rate limit hit for current proxy while checking ${url}. Rotating proxy.`);
                    if (!rotateProxy()) {
                        return true;
                    }
                    continue;
                }
                throw new Error(`API request failed with status: ${response.status}`);
            }

            const data = await response.json();
            
            const categoryA = data.data?.a?.cat;
            const categoryB = data.data?.b?.cat;

            if (categoryA === undefined || categoryB === undefined) {
                console.warn(`[WARN] Could not retrieve categorization data for ${url}. Skipping.`);
                return true;
            }

            const catNumA = Number(categoryA);
            const catNumB = Number(categoryB);

            const isCategoryAUnblocked = UNBLOCKED_CATEGORY_NUMBERS.includes(catNumA);
            const isCategoryBUnblocked = UNBLOCKED_CATEGORY_NUMBERS.includes(catNumB);

            return !(isCategoryAUnblocked && isCategoryBUnblocked);

        } catch (error) {
            if (error.message.includes('ECONNREFUSED') || error.message.includes('ETIMEDOUT') || error.message.includes('Proxy connection failed')) {
                console.warn(`[WARN] Proxy connection failed for ${proxyUrl}. Rotating proxy.`);
                if (!rotateProxy()) {
                    return true;
                }
                continue;
            }
            
            console.error(`[ERROR] Domain check failed for ${url}:`, error.message);
            return true;
        }
    }
}

const scrapeAndCheckPage = async (page, url) => {
    console.log(`\nNavigating to: ${url}`);
    try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    } catch(err) {
        console.error(`[ERROR] Failed to navigate to ${url}:`, err.message);
        return;
    }
    
    const domainsOnPage = await page.evaluate(() => {
        const articles = document.querySelectorAll('.trl, .trd');

        return Array.from(articles).map((article) => {
            const td = article.querySelector('td');
            const domainElement = td ? td.querySelector('a') : null;
            return domainElement ? domainElement.textContent.trim() : null;
        }).filter(domain => domain);
    });

    console.log(`Found ${domainsOnPage.length} domains on this page. Checking...`);

    for (const domain of domainsOnPage) {
        const isBlocked = await checkDomain(domain);
        if (!isBlocked) {
            await appendDomainToFile(domain);
            unblockedCount++;
            console.log(`[SUCCESS] ${domain} is UNBLOCKED. Total found: ${unblockedCount}`);
        }
    }
}

const loopPages = async () => {
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36');

    console.log(`Starting scrape from page ${START_PAGE} to ${END_PAGE}.`);

    for(let i = START_PAGE; i <= END_PAGE; i++) { 
        const url = BASE_URL + i + "&sort=5&q=";
        await scrapeAndCheckPage(page, url);
        
        const percentage = i / END_PAGE * 100;
        console.log(`--- Page ${i}/${END_PAGE} complete (${Math.round(percentage * 100) / 100}%) ---`);
    }

    await browser.close();
}

async function main() {
    try {
        await loadProxies();
        await loopPages();
        
        console.log("\n========================================");
        console.log(`Finished checking pages ${START_PAGE} to ${END_PAGE}.`);
        console.log(`Found ${unblockedCount} UNBLOCKED domains.`);
        console.log(`Results appended to ${OUTPUT_FILE}`);
        console.log("========================================");

    } catch (error) {
        console.error("\n[FATAL ERROR] An unexpected error occurred:", error.message);
    }
}

main();