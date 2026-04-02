const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const fs = require('fs').promises;
const chalk = require('chalk');
const ProxyAgent = require('proxy-agent');

puppeteer.use(StealthPlugin());

const CONFIG = {
    antiCaptchaKey: process.env.ANTICAPTCHA_KEY || '373271de10fac6ff5aa75a2928acd339',
    // Bright Data residential proxy - rotating IP every request
    proxy: {
        host: 'brd.superproxy.io',
        port: 22225,
        username: 'brd-customer-[CUSTOMER_ID]-zone-residential',
        password: '[ZONE_PASSWORD]'
    }
};

// Alternative proxy providers if Bright Data fails
const PROXY_PROVIDERS = [
    { name: 'Bright Data', url: 'http://brd.superproxy.io:22225' },
    { name: 'Oxylabs', url: 'http://customer-xxx:password@pr.oxylabs.io:7777' },
    { name: 'Smartproxy', url: 'http://user:pass@gate.smartproxy.com:7000' },
    { name: 'PacketStream', url: 'http://username:password@proxy.packetstream.io:31112' }
];

class ProxyRotator {
    constructor() {
        this.currentProxyIndex = 0;
        this.failedProxies = new Set();
        this.testedProxies = new Map(); // proxy -> { working: boolean, latency: number }
    }

    getProxyUrl(provider) {
        const { username, password, host, port } = provider;
        return `http://${username}:${password}@${host}:${port}`;
    }

    async testProxy(proxyUrl) {
        console.log(chalk.blue(`[Proxy Test] Testing ${proxyUrl.replace(/\/\/.*@/, '//***@')}`));
        
        try {
            const start = Date.now();
            const response = await axios.get('https://discord.com/api/v9/gateway', {
                proxy: false,
                httpsAgent: new ProxyAgent(proxyUrl),
                timeout: 15000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });
            
            const latency = Date.now() - start;
            const isWorking = response.status === 200;
            
            // Check if Discord flags it (captcha on gateway means flagged IP)
            const isFlagged = response.data && response.data.url && response.data.url.includes('captcha');
            
            this.testedProxies.set(proxyUrl, { 
                working: isWorking && !isFlagged, 
                latency,
                flagged: isFlagged
            });
            
            if (isWorking && !isFlagged) {
                console.log(chalk.green(`[Proxy Test] ✅ WORKING - Latency: ${latency}ms`));
                return true;
            } else if (isFlagged) {
                console.log(chalk.red(`[Proxy Test] ❌ FLAGGED BY DISCORD - Captcha required`));
                return false;
            }
            
            return false;
        } catch (err) {
            console.log(chalk.red(`[Proxy Test] ❌ FAILED: ${err.message}`));
            this.testedProxies.set(proxyUrl, { working: false, latency: Infinity });
            return false;
        }
    }

    async findWorkingProxy() {
        console.log(chalk.blue(`[Proxy] Searching for working non-flagged IP...`));
        
        for (const provider of PROXY_PROVIDERS) {
            if (this.failedProxies.has(provider.name)) continue;
            
            // Try 3 different sessions (IPs) per provider
            for (let session = 1; session <= 3; session++) {
                const proxyUrl = this.getProxyUrl({
                    ...CONFIG.proxy,
                    username: `${CONFIG.proxy.username}-session-${session}`
                });
                
                if (await this.testProxy(proxyUrl)) {
                    console.log(chalk.green.bold(`[✓] Found working proxy: ${provider.name} session ${session}`));
                    return proxyUrl;
                }
                
                await this.delay(2000, 3000);
            }
        }
        
        throw new Error('No working proxies found');
    }

    getRandomSessionProxy() {
        // Generate random session ID for new IP
        const sessionId = Math.random().toString(36).substring(7);
        return this.getProxyUrl({
            ...CONFIG.proxy,
            username: `${CONFIG.proxy.username}-session-${sessionId}`
        });
    }

    delay(min, max) {
        return new Promise(r => setTimeout(r, Math.floor(Math.random() * (max - min) + min)));
    }
}

class AntiCaptchaSolver {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.baseUrl = 'https://api.anti-captcha.com';
    }

    async solveHcaptcha(pageUrl, siteKey) {
        console.log(chalk.blue(`[AntiCaptcha] Creating task...`));
        
        const createRes = await axios.post(`${this.baseUrl}/createTask`, {
            clientKey: this.apiKey,
            task: {
                type: 'HCaptchaTaskProxyless',
                websiteURL: pageUrl,
                websiteKey: siteKey
            }
        });

        if (createRes.data.errorId !== 0) {
            throw new Error(`AntiCaptcha error: ${createRes.data.errorDescription}`);
        }

        const taskId = createRes.data.taskId;
        
        for (let i = 0; i < 60; i++) {
            await new Promise(r => setTimeout(r, 5000));
            
            const result = await axios.post(`${this.baseUrl}/getTaskResult`, {
                clientKey: this.apiKey,
                taskId: taskId
            });

            if (result.data.status === 'ready') {
                console.log(chalk.green(`[AntiCaptcha] Solution received!`));
                return result.data.solution.gRecaptchaResponse;
            }
        }
        throw new Error('Timeout');
    }

    async getBalance() {
        const res = await axios.post(`${this.baseUrl}/getBalance`, { clientKey: this.apiKey });
        return res.data.balance;
    }
}

class DiscordRegisterPage {
    constructor(browser, page, proxyUrl) {
        this.browser = browser;
        this.page = page;
        this.proxyUrl = proxyUrl;
        this.capturedToken = null;
        this.setupRequestInterception();
    }

    setupRequestInterception() {
        this.page.on('response', async (response) => {
            const url = response.url();
            if (url.includes('discord.com/api/v9/auth/register')) {
                const status = response.status();
                console.log(chalk.yellow(`[REGISTER] Status: ${status}`));
                
                try {
                    const body = await response.json();
                    if (body.token) {
                        this.capturedToken = body.token;
                        console.log(chalk.green.bold(`[✓✓✓] TOKEN CAPTURED! [✓✓✓]`));
                    }
                    if (body.retry_after) {
                        console.log(chalk.red(`[RATE LIMIT] Wait ${body.retry_after}s`));
                    }
                } catch (e) {}
            }
        });
    }

    static async create(proxyUrl) {
        const args = [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--window-size=1366,768',
            `--proxy-server=${proxyUrl}`
        ];

        const browser = await puppeteer.launch({
            headless: 'new',
            args
        });

        const page = await browser.newPage();
        
        // Authenticate proxy
        const proxyAuth = new URL(proxyUrl);
        await page.authenticate({
            username: decodeURIComponent(proxyAuth.username),
            password: decodeURIComponent(proxyAuth.password)
        });

        await page.setViewport({ width: 1366, height: 768 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // Override permissions to look more legit
        const context = browser.defaultBrowserContext();
        await context.overridePermissions('https://discord.com', ['notifications']);
        
        return new DiscordRegisterPage(browser, page, proxyUrl);
    }

    async navigate() {
        // Clear cookies/cache for fresh session
        const client = await this.page.target().createCDPSession();
        await client.send('Network.clearBrowserCookies');
        await client.send('Network.clearBrowserCache');
        
        await this.page.goto('https://discord.com/register', { 
            waitUntil: 'networkidle0', 
            timeout: 60000 
        });
        
        // Check if we got captcha on load (flagged IP)
        const isFlagged = await this.page.$('iframe[src*="hcaptcha"]') !== null;
        if (isFlagged) {
            console.log(chalk.red(`[IP CHECK] ⚠️  IP is flagged - captcha on load`));
            throw new Error('Flagged IP');
        }
        
        console.log(chalk.green(`[IP CHECK] ✅ IP looks clean - no captcha on load`));
        await this.delay(3000, 5000);
    }

    async fillForm(data) {
        console.log(chalk.blue('[+] Filling form...'));
        
        await this.fillField('input[type="email"]', data.email);
        await this.fillField('input[name="username"]', data.username);
        await this.fillField('input[type="password"]', data.password);
        await this.fillDOB(data.month, data.day, data.year);
        
        await this.page.evaluate(() => {
            document.querySelectorAll('input[type="checkbox"]').forEach(cb => {
                if (!cb.checked) cb.click();
            });
        });

        await this.delay(1000, 2000);
        console.log(chalk.green('[+] Form filled'));
    }

    async fillField(selector, value) {
        const el = await this.page.waitForSelector(selector, { visible: true });
        await el.click({ clickCount: 3 });
        await this.page.keyboard.press('Backspace');
        await this.page.keyboard.type(value, { delay: 50 });
        await this.delay(200, 500);
    }

    async fillDOB(month, day, year) {
        const dropdowns = await this.page.$$('div[role="button"][aria-haspopup="listbox"]');
        const values = [month, day, year];
        
        for (let i = 0; i < 3; i++) {
            await dropdowns[i].click();
            await this.delay(500, 800);
            await this.page.evaluate((val) => {
                document.querySelectorAll('[role="option"]').forEach(opt => {
                    if (opt.textContent.trim() === val) opt.click();
                });
            }, values[i]);
            await this.delay(500, 800);
        }
    }

    async submitAndSolveCaptcha(solver) {
        console.log(chalk.blue('[+] Submitting...'));
        
        // Click Create Account
        await this.page.evaluate(() => {
            const btn = Array.from(document.querySelectorAll('button')).find(b => 
                b.textContent.toLowerCase().includes('create account') && !b.disabled
            );
            if (btn) {
                btn.scrollIntoView();
                btn.click();
            }
        });
        
        await this.delay(3000, 5000);

        // Check for captcha
        const hasCaptcha = await this.page.$('iframe[src*="hcaptcha"]') !== null;
        
        if (hasCaptcha) {
            console.log(chalk.yellow('[!] Solving captcha...'));
            
            const siteKey = await this.page.evaluate(() => {
                return document.querySelector('[data-sitekey]')?.getAttribute('data-sitekey') || 
                       'a9b5fb07-92ff-493f-86fe-352a2803b3df'; // From your logs
            });

            const solution = await solver.solveHcaptcha('https://discord.com/register', siteKey);
            
            await this.page.evaluate((token) => {
                document.querySelectorAll('textarea').forEach(ta => {
                    if (ta.name.includes('h-captcha') || ta.id.includes('h-captcha')) {
                        ta.value = token;
                        ['input', 'change'].forEach(evt => {
                            ta.dispatchEvent(new Event(evt, { bubbles: true }));
                        });
                    }
                });
            }, solution);

            await this.delay(2000, 3000);

            // Re-submit
            console.log(chalk.blue('[+] Re-submitting after captcha...'));
            await this.page.evaluate(() => {
                const btn = Array.from(document.querySelectorAll('button')).find(b => 
                    b.textContent.toLowerCase().includes('create account') && !b.disabled
                );
                if (btn) {
                    btn.scrollIntoView();
                    btn.click();
                    setTimeout(() => btn.click(), 500);
                }
            });
        }

        // Wait for success
        console.log(chalk.blue('[+] Waiting for registration...'));
        
        for (let i = 0; i < 30; i++) {
            await this.delay(2000, 3000);
            
            if (this.capturedToken) {
                console.log(chalk.green.bold(`[✓✓✓] SUCCESS! [✓✓✓]`));
                return this.capturedToken;
            }
            
            const url = this.page.url();
            if (url.includes('/channels') || url.includes('/app')) {
                return await this.getTokenFromStorage();
            }
            
            // Check for rate limit message
            const rateLimited = await this.page.evaluate(() => {
                return document.body.textContent.includes('rate limited');
            });
            
            if (rateLimited) {
                console.log(chalk.red(`[RATE LIMIT DETECTED] Current IP flagged`));
                throw new Error('Rate limited - need new IP');
            }
        }

        return null;
    }

    async getTokenFromStorage() {
        const token = await this.page.evaluate(() => {
            return window.localStorage?.getItem('token')?.replace(/"/g, '');
        });
        return token || 'ACCOUNT_CREATED_NO_TOKEN';
    }

    async close() {
        await this.browser.close();
    }

    delay(min, max) {
        return new Promise(r => setTimeout(r, Math.floor(Math.random() * (max - min) + min)));
    }
}

class AccountGenerator {
    constructor(deps) {
        this.emailProvider = deps.emailProvider;
        this.captchaSolver = deps.captchaSolver;
        this.proxyRotator = deps.proxyRotator;
        this.metrics = { attempts: 0, success: 0, fail: 0 };
    }

    async generate() {
        this.metrics.attempts++;
        let page = null;
        let email = null;
        let proxyUrl = null;

        try {
            // Test and find working proxy first
            proxyUrl = await this.proxyRotator.findWorkingProxy();
            
            const balance = await this.captchaSolver.getBalance();
            console.log(chalk.blue(`[AntiCaptcha] Balance: $${balance}`));
            if (balance < 0.002) throw new Error('Balance too low');

            email = await this.emailProvider.createAccount();
            page = await DiscordRegisterPage.create(proxyUrl);
            
            await page.navigate();
            await page.fillForm({
                email: email.email,
                username: this.genUsername(),
                password: email.password,
                month: this.randMonth(),
                day: Math.floor(Math.random() * 28 + 1).toString(),
                year: Math.floor(Math.random() * (2004 - 1990) + 1990).toString()
            });
            
            const token = await page.submitAndSolveCaptcha(this.captchaSolver);
            
            if (!token) throw new Error('No token obtained');

            console.log(chalk.green.bold(`\n╔════════════════════════════════════════════════════════════╗`));
            console.log(chalk.green.bold(`║       [✓✓✓] ACCOUNT CREATED SUCCESSFULLY! [✓✓✓]           ║`));
            console.log(chalk.green.bold(`╠════════════════════════════════════════════════════════════╣`));
            console.log(chalk.green(`║  Email:    ${email.email.padEnd(45)}║`));
            console.log(chalk.green(`║  Password: ${email.password.padEnd(45)}║`));
            console.log(chalk.green(`║  Token:    ${token.slice(0, 40).padEnd(45)}║`));
            console.log(chalk.green(`║  Proxy:    ${proxyUrl.split('@')[1].padEnd(45)}║`));
            console.log(chalk.green.bold(`╚════════════════════════════════════════════════════════════╝\n`));

            let verified = false;
            try {
                const verifyUrl = await this.emailProvider.getVerificationEmail(email.token, 60000);
                if (verifyUrl && token !== 'ACCOUNT_CREATED_NO_TOKEN') {
                    verified = await page.verifyEmail(token, verifyUrl);
                }
            } catch (e) {}

            await this.save(email, token, verified, proxyUrl);
            this.metrics.success++;
            
            console.log(chalk.green.bold(`[✓✓✓] SAVED [✓✓✓]`));
            
            return { success: true, token, verified, email: email.email };

        } catch (err) {
            this.metrics.fail++;
            console.log(chalk.red(`[Error] ${err.message}`));
            
            // If rate limited, mark proxy as failed and retry
            if (err.message.includes('Rate limited') || err.message.includes('Flagged IP')) {
                if (proxyUrl) {
                    console.log(chalk.yellow(`[Proxy] Marking as failed, will try new IP...`));
                    this.proxyRotator.failedProxies.add(proxyUrl);
                }
                // Retry with new proxy
                console.log(chalk.blue(`[Retry] Attempting with new proxy...`));
                return this.generate();
            }
            
            throw err;
        } finally {
            if (page) await page.close();
        }
    }

    genUsername() {
        const adj = ['Shadow', 'Silent', 'Dark', 'Ghost', 'Cyber'][Math.floor(Math.random() * 5)];
        const noun = ['Hunter', 'Wraith', 'Ninja', 'Coder'][Math.floor(Math.random() * 4)];
        return `${adj}${noun}${Math.floor(Math.random() * 99999)}`;
    }

    randMonth() {
        const months = ['January', 'February', 'March', 'April', 'May', 'June', 
                       'July', 'August', 'September', 'October', 'November', 'December'];
        return months[Math.floor(Math.random() * 12)];
    }

    async save(data, token, verified, proxyUrl) {
        const line = `${data.email}:${data.password}:${token}:${proxyUrl}\n`;
        await fs.appendFile(verified ? 'verified.txt' : 'unverified.txt', line);
    }

    getMetrics() {
        return { ...this.metrics };
    }
}

async function main() {
    console.log(chalk.green.bold('[+] Starting Discord Account Generator with Proxy Rotation...'));
    
    const gen = new AccountGenerator({
        emailProvider: new MailTmProvider(),
        captchaSolver: new AntiCaptchaSolver(CONFIG.antiCaptchaKey),
        proxyRotator: new ProxyRotator()
    });

    try {
        const result = await gen.generate();
        console.log(chalk.blue(`[Metrics] Success: ${gen.getMetrics().success}, Fail: ${gen.getMetrics().fail}`));
    } catch (err) {
        console.error(chalk.red(`[Failed] ${err.message}`));
    }
    
    console.log(chalk.green('[+] Done'));
    process.exit(0);
}

if (require.main === module) {
    main().catch(err => {
        console.error(chalk.red(err));
        process.exit(1);
    });
}
