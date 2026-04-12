const fs = require('fs-extra');
const chalk = require('chalk');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { firefox } = require('playwright');
require('dotenv').config();

// ==================== CONFIG ====================
const config = {
    ANTICAPTCHA_KEY: process.env.ANTICAPTCHA_KEY,
    TARGET_COUNT: parseInt(process.env.TARGET_COUNT) || 5,
    MAX_RETRIES: parseInt(process.env.MAX_RETRIES) || 10,
    PROXY_TIMEOUT: parseInt(process.env.PROXY_TIMEOUT) || 10000,
    PROXY_CONCURRENCY: parseInt(process.env.PROXY_CONCURRENCY) || 100,
    MIN_PROXIES: parseInt(process.env.MIN_PROXIES) || 50,
    HEADLESS: process.env.HEADLESS !== 'false',
    DELAY_MIN: parseInt(process.env.DELAY_MIN) || 3000,
    DELAY_MAX: parseInt(process.env.DELAY_MAX) || 8000,
    
    validate() {
        if (!this.ANTICAPTCHA_KEY || this.ANTICAPTCHA_KEY === 'your-key-here') {
            throw new Error('ANTICAPTCHA_KEY not set in environment variables');
        }
        return true;
    }
};

// ==================== CAPTCHA SOLVER ====================
class CaptchaSolver {
    async getBalance() {
        try {
            const res = await axios.get('http://api.anti-captcha.com/getBalance', {
                params: { clientKey: config.ANTICAPTCHA_KEY }
            });
            return res.data.balance || 0;
        } catch {
            return 0;
        }
    }

    async solve(pageUrl, siteKey, proxy) {
        // Create task
        const taskRes = await axios.post('http://api.anti-captcha.com/createTask', {
            clientKey: config.ANTICAPTCHA_KEY,
            task: {
                type: 'HCaptchaTask',
                websiteURL: pageUrl,
                websiteKey: siteKey,
                proxyType: proxy.type,
                proxyAddress: proxy.ip,
                proxyPort: proxy.port,
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0'
            }
        });

        if (taskRes.data.errorId !== 0) {
            throw new Error(`AntiCaptcha error: ${taskRes.data.errorDescription}`);
        }

        const taskId = taskRes.data.taskId;

        // Poll for result
        for (let i = 0; i < 60; i++) {
            await new Promise(r => setTimeout(r, 5000));
            
            const resultRes = await axios.post('http://api.anti-captcha.com/getTaskResult', {
                clientKey: config.ANTICAPTCHA_KEY,
                taskId: taskId
            });

            if (resultRes.data.status === 'ready') {
                return resultRes.data.solution.gRecaptchaResponse;
            }
        }

        throw new Error('Captcha solve timeout');
    }
}

// ==================== STEALTH BROWSER ====================
class StealthBrowser {
    constructor(proxy) {
        this.proxy = proxy;
        this.browser = null;
        this.page = null;
    }

    async launch() {
        const proxyServer = this.proxy.type === 'socks5'
            ? `socks5://${this.proxy.ip}:${this.proxy.port}`
            : `http://${this.proxy.ip}:${this.proxy.port}`;

        this.browser = await firefox.launch({
            headless: config.HEADLESS,
            proxy: { server: proxyServer }
        });

        const context = await this.browser.newContext({
            viewport: { width: 1366, height: 768 },
            locale: 'en-US',
            timezoneId: 'America/New_York',
            colorScheme: 'dark'
        });

        await context.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            Object.defineProperty(navigator, 'plugins', { get: () => [{name: 'PDF Viewer'}] });
            delete window.__webdriver_script_fn;
        });

        this.page = await context.newPage();
        
        await this.page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'DNT': '1'
        });

        return this;
    }

    async goto(url) {
        await this.page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
        await this.delay(config.DELAY_MIN, config.DELAY_MAX);
    }

    async delay(min = config.DELAY_MIN, max = config.DELAY_MAX) {
        const ms = Math.floor(Math.random() * (max - min) + min);
        await this.page.waitForTimeout(ms);
    }

    async type(selector, text) {
        const el = this.page.locator(selector).first();
        await el.click({ delay: Math.random() * 100 + 50 });
        await this.delay(100, 300);
        
        const wpm = 35 + Math.random() * 25;
        const msPerChar = 60000 / (wpm * 5);
        
        for (const char of text) {
            await el.type(char, { delay: msPerChar * (0.5 + Math.random()) });
            if (Math.random() < 0.03) await this.delay(200, 500);
        }
        
        await this.delay();
    }

    async selectDropdown(index, value) {
        const dropdowns = await this.page.locator('div[role="button"][aria-haspopup="listbox"]').all();
        if (dropdowns[index]) {
            await dropdowns[index].click();
            await this.delay(200, 500);
            await this.page.locator('[role="option"]', { hasText: value }).first().click();
            await this.delay(300, 600);
        }
    }

    async close() {
        if (this.browser) await this.browser.close();
    }
}

// ==================== PROXY SCRAPER ====================
const PROXY_SOURCES = [
    'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=10000&country=all',
    'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all',
    'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt',
    'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
    'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt',
    'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
    'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/socks5.txt',
    'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt',
    'https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt',
    'https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/proxies.txt'
];

async function scrapeProxies() {
    console.log(chalk.blue('[Scraper] Fetching proxies...'));
    const proxies = new Set();
    
    await Promise.all(PROXY_SOURCES.map(async (source) => {
        try {
            const res = await axios.get(source, { 
                timeout: 15000,
                headers: { 'User-Agent': 'Mozilla/5.0' }
            });
            const lines = res.data.split('\n')
                .map(l => l.trim())
                .filter(l => /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{2,5}$/.test(l));
            lines.forEach(l => proxies.add(l));
        } catch (e) {
            // Silent fail for individual sources
        }
    }));
    
    console.log(chalk.blue(`[Scraper] Found ${proxies.size} unique proxies`));
    return Array.from(proxies);
}

async function testProxy(proxyStr, type = 'http') {
    const [ip, port] = proxyStr.split(':');
    const proxyUrl = type === 'socks5' 
        ? `socks5://${ip}:${port}` 
        : `http://${ip}:${port}`;
    
    try {
        const agent = type === 'socks5' 
            ? new SocksProxyAgent(proxyUrl) 
            : new HttpsProxyAgent(proxyUrl);
        
        const start = Date.now();
        const res = await axios.get('https://discord.com/api/v9/gateway', {
            httpsAgent: agent,
            httpAgent: agent,
            timeout: 8000,
            validateStatus: () => true
        });
        
        const latency = Date.now() - start;
        
        if (res.status === 200 && res.data?.url && !res.data.url.includes('captcha')) {
            return { working: true, latency, type, ip, port: parseInt(port) };
        }
        return { working: false };
    } catch {
        return { working: false };
    }
}

async function validateProxies(proxyList, concurrency = 100) {
    console.log(chalk.yellow(`[Validator] Testing ${proxyList.length} proxies (${concurrency} threads)...`));
    
    const working = await this.delay(config.DELAY_MIN, config.DELAY_MAX);
    }

    async delay(min = config.DELAY_MIN, max = config.DELAY_MAX) {
        const ms = Math.floor(Math.random() * (max - min) + min);
        await this.page.waitForTimeout(ms);
    }

    async type(selector, text) {
        const el = this.page.locator(selector).first();
        await el.click({ delay: Math.random() * 100 + 50 });
        await this.delay(100, 300);
        
        const wpm = 35 + Math.random() * 25;
        const msPerChar = 60000 / (wpm * 5);
        
        for (const char of text) {
            await el.type(char, { delay: msPerChar * (0.5 + Math.random()) });
            if (Math.random() < 0.03) await this.delay(200, 500);
        }
        
        await this.delay();
    }

    async selectDropdown(index, value) {
        const dropdowns = await this.page.locator('div[role="button"][aria-haspopup="listbox"]').all();
        if (dropdowns[index]) {
            await dropdowns[index].click();
            await this.delay(200, 500);
            await this.page.locator('[role="option"]', { hasText: value }).first().click();
            await this.delay(300, 600);
        }
    }

    async close() {
        if (this.browser) await this.browser.close();
    }
}

// ==================== PROXY SCRAPER ====================
const PROXY_SOURCES = [
    'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=10000&country=all',
    'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all',
    'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt',
    'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
    'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt',
    'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
    'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/socks5.txt',
    'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt',
    'https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt',
    'https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/proxies.txt'
];

async function scrapeProxies() {
    console.log(chalk.blue('[Scraper] Fetching proxies...'));
    const proxies = new Set();
    
    await Promise.all(PROXY_SOURCES.map(async (source) => {
        try {
            const res = await axios.get(source, { 
                timeout: 15000,
                headers: { 'User-Agent': 'Mozilla/5.0' }
            });
            const lines = res.data.split('\n')
                .map(l => l.trim())
                .filter(l => /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{2,5}$/.test(l));
            lines.forEach(l => proxies.add(l));
        } catch (e) {
            // Silent fail for individual sources
        }
    }));
    
    console.log(chalk.blue(`[Scraper] Found ${proxies.size} unique proxies`));
    return Array.from(proxies);
}

async function testProxy(proxyStr, type = 'http') {
    const [ip, port] = proxyStr.split(':');
    const proxyUrl = type === 'socks5' 
        ? `socks5://${ip}:${port}` 
        : `http://${ip}:${port}`;
    
    try {
        const agent = type === 'socks5' 
            ? new SocksProxyAgent(proxyUrl) 
            : new HttpsProxyAgent(proxyUrl);
        
        const start = Date.now();
        const res = await axios.get('https://discord.com/api/v9/gateway', {
            httpsAgent: agent,
            httpAgent: agent,
            timeout: 8000,
            validateStatus: () => true
        });
        
        const latency = Date.now() - start;
        
        if (res.status === 200 && res.data?.url && !res.data.url.includes('captcha')) {
            return { working: true, latency, type, ip, port: parseInt(port) };
        }
        return { working: false };
    } catch {
        return { working: false };
    }
}

async function validateProxies(proxyList, concurrency = 100) {
    console.log(chalk.yellow(`[Validator] Testing ${proxyList.length} proxies (${concurrency} threads)...`));
    
    const working = [];
    
    for (let i = 0; i < proxyList.length; i += concurrency) {
        const batch = proxyList.slice(i, i + concurrency);
        const results = await Promise.all(
            batch.map(async (proxy) => {
                let result = await testProxy(proxy, 'http');
                if (!result.working && ['1080', '1085', '4145', '9050'].includes(proxy.split(':')[1])) {
                    result = await testProxy(proxy, 'socks5');
                }
                return { proxy, ...result };
            })
        );
        
        results.forEach(r => {
            if (r.working) {
                working.push({
                    id: r.proxy,
                    ip: r.ip,
                    port: r.port,
                    type: r.type,
                    latency: r.latency,
                    lastUsed: 0,
                    failCount: 0
                });
            }
        });
        
        process.stdout.write(chalk.gray(`\r  Tested: ${Math.min(i + concurrency, proxyList.length)}/${proxyList.length} | Working: ${working.length}`));
    }
    
    console.log(chalk.green(`\n[Validator] ${working.length} working proxies`));
    
    working.sort((a, b) => a.latency - b.latency);
    
    await fs.ensureDir('/tmp');
    await fs.writeJson('/tmp/working_proxies.json', working);
    
    return working;
}

async function scrapeAndValidate() {
    const proxies = await scrapeProxies();
    if (proxies.length === 0) {
        throw new Error('No proxies scraped from any source');
    }
    return await validateProxies(proxies, 150);
}

// ==================== GENERATOR ====================
class Generator {
    constructor() {
        this.solver = new CaptchaSolver();
        this.stats = { attempts: 0, success: 0, failed: 0 };
    }

    randomUser() {
        const adj = ['Shadow','Silent','Dark','Ghost','Cyber','Neon','Phantom'][Math.floor(Math.random()*7)];
        const noun = ['Hunter','Wraith','Ninja','Coder','Spectre'][Math.floor(Math.random()*5)];
        const num = Math.floor(Math.random()*99999);
        const user = `${adj}${noun}${num}`;
        return {
            username: user,
            email: `${user.toLowerCase()}${num}@gmail.com`,
            password: Array(16).fill(0).map(() => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*'[Math.floor(Math.random()*72)]).join(''),
            dob: {
                month: ['January','February','March','April','May','June','July','August','September','October','November','December'][Math.floor(Math.random()*12)],
                day: Math.floor(Math.random()*28+1).toString(),
                year: Math.floor(Math.random()*(2004-1990)+1990).toString()
            }
        };
    }

    async generate(proxy) {
        this.stats.attempts++;
        const browser = new StealthBrowser(proxy);
        let token = null;

        try {
            console.log(chalk.blue(`\n[Gen] Using ${proxy.id}`));
            await browser.launch();
            await browser.goto('https://discord.com/register');

            // Check flagged
            const flagged = await browser.page.locator('iframe[src*="hcaptcha"]').count() > 0;
            if (flagged) throw new Error('Flagged IP');

            const user = this.randomUser();
            console.log(chalk.gray(`  ${user.email}`));

            // Fill form
            await browser.type('input[type="email"]', user.email);
            await browser.type('input[name="username"]', user.username);
            await browser.type('input[type="password"]', user.password);
            await browser.selectDropdown(0, user.dob.month);
            await browser.selectDropdown(1, user.dob.day);
            await browser.selectDropdown(2, user.dob.year);
            
            await browser.page.locator('input[type="checkbox"]').first().check();
            await browser.delay(500, 1000);

            // Submit
            await browser.page.locator('button:has-text("Continue")').first().click();
            await browser.delay(3000, 5000);

            // Handle captcha
            const hasCaptcha = await browser.page.locator('iframe[src*="hcaptcha"]').first().isVisible().catch(() => false);
            if (hasCaptcha) {
                const siteKey = await browser.page.evaluate(() => document.querySelector('[data-sitekey]')?.dataset.sitekey || 'a9b5fb07-92ff-493f-86fe-352a2803b3df');
                const solution = await this.solver.solve('https://discord.com/register', siteKey, proxy);
                
                await browser.page.evaluate((tok) => {
                    document.querySelectorAll('textarea').forEach(ta => {
                        if (ta.name.includes('h-captcha')) {
                            ta.value = tok;
                            ta.dispatchEvent(new Event('input', { bubbles: true }));
                        }
                    });
                }, solution);
                
                await browser.delay(2000, 3000);
                await browser.page.locator('button:has-text("Continue")').first().click();
                await browser.delay(5000, 8000);
            }

            // Get token
            for (let i = 0; i < 15; i++) {
                token = await browser.page.evaluate(() => localStorage.getItem('token')?.replace(/"/g, ''));
                if (token) break;
                
                const url = browser.page.url();
                if (url.includes('/channels') || url.includes('/app')) {
                    token = await browser.page.evaluate(() => localStorage.getItem('token')?.replace(/"/g, ''));
                    break;
                }
                
                const err = await browser.page.locator('text=/rate limited|already registered/i').first().innerText().catch(() => null);
                if (err) throw new Error(err);
                
                await browser.delay(1000, 1500);
            }

            if (!token) throw new Error('No token');

            this.stats.success++;
            const account = { ...user, token, proxy: proxy.id, createdAt: new Date().toISOString() };
            
            await fs.appendFile('/tmp/accounts.txt', `${account.email}:${account.password}:${account.token}:${account.proxy}\n`);
            console.log(chalk.green.bold('  ✓ Success'));
            
            return account;

        } catch (err) {
            this.stats.failed++;
            console.log(chalk.red(`  ✗ ${err.message}`));
            throw err;
        } finally {
            await browser.close();
        }
    }

    printStats() {
        console.log(chalk.cyan.bold('\n=== STATS ==='));
        console.log(`Attempts: ${this.stats.attempts}`);
        console.log(chalk.green(`Success: ${this.stats.success}`));
        console.log(chalk.red(`Failed: ${this.stats.failed}`));
    }
}

// ==================== MAIN ====================
async function main() {
    console.log(chalk.green.bold('=== Discord Generator ===\n'));
    
    config.validate();
    
    // Check balance
    const balance = await new CaptchaSolver().getBalance();
    console.log(chalk.blue(`Balance: $${balance}`));
    
    // Load or scrape proxies - AUTO-SCRAPE IF NONE
    let proxies = [];
    try {
        proxies = await fs.readJson('/tmp/working_proxies.json');
        console.log(chalk.blue(`Loaded ${proxies.length} cached proxies`));
        
        if (proxies.length < config.MIN_PROXIES) {
            console.log(chalk.yellow('Insufficient cached proxies, rescraping...'));
            throw new Error('Need fresh proxies');
        }
    } catch {
        console.log(chalk.yellow('No valid proxy cache found. Running scraper...'));
        proxies = await scrapeAndValidate();
    }
    
    if (proxies.length === 0) {
        console.log(chalk.red('No working proxies found after scraping'));
        process.exit(1);
    }
    
    console.log(chalk.green(`Ready with ${proxies.length} proxies`));
    
    // Generate
    const gen = new Generator();
    let count = 0;
    let proxyIndex = 0;
    
    while (count < config.TARGET_COUNT && proxyIndex < proxies.length) {
        const proxy = proxies[proxyIndex++];
        
        try {
            await gen.generate(proxy);
            count++;
            
            if (count < config.TARGET_COUNT) {
                const delay = Math.random() * 5000 + 5000;
                console.log(chalk.gray(`Waiting ${Math.round(delay)}ms...`));
                await new Promise(r => setTimeout(r, delay));
            }
        } catch (err) {
            console.log(chalk.yellow(`Proxy failed, trying next...`));
            continue;
        }
    }
    
    gen.printStats();
    
    if (count === 0) {
        console.log(chalk.red('No accounts generated. All proxies failed.'));
        process.exit(1);
    }
    
    console.log(chalk.green(`Done! Generated ${count}/${config.TARGET_COUNT} accounts`));
    process.exit(0);
}

main().catch(e => {
    console.error(chalk.red(e.message));
    process.exit(1);
});
