const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const fs = require('fs').promises;
const chalk = require('chalk');

puppeteer.use(StealthPlugin());

const CONFIG = {
    antiCaptchaKey: process.env.ANTICAPTCHA_KEY || '373271de10fac6ff5aa75a2928acd339'
};

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
        }, { timeout: 30000 });

        if (createRes.data.errorId !== 0) {
            throw new Error(`AntiCaptcha error: ${createRes.data.errorDescription}`);
        }

        const taskId = createRes.data.taskId;
        console.log(chalk.blue(`[AntiCaptcha] Task created: ${taskId}`));

        for (let i = 0; i < 60; i++) {
            await new Promise(r => setTimeout(r, 5000));
            
            const result = await axios.post(`${this.baseUrl}/getTaskResult`, {
                clientKey: this.apiKey,
                taskId: taskId
            }, { timeout: 30000 });

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

class MailTmProvider {
    constructor() {
        this.baseUrl = 'https://api.mail.tm';
    }

    async createAccount() {
        const domains = await axios.get(`${this.baseUrl}/domains`);
        const domain = domains.data['hydra:member'][0].domain;
        const email = `user${Date.now()}${Math.floor(Math.random() * 1000)}@${domain}`;
        const password = Array.from({length: 16}, () => 
            'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*'[Math.floor(Math.random() * 70)]
        ).join('');

        await axios.post(`${this.baseUrl}/accounts`, { address: email, password });
        const auth = await axios.post(`${this.baseUrl}/token`, { address: email, password });

        console.log(chalk.green(`[+] Email: ${email}`));
        return { email, password, token: auth.data.token };
    }

    async getVerificationEmail(token, timeout = 120000) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            const msgs = await axios.get(`${this.baseUrl}/messages`, {
                headers: { Authorization: `Bearer ${token}` }
            });

            for (const msg of msgs.data['hydra:member']) {
                const detail = await axios.get(`${this.baseUrl}/messages/${msg.id}`, {
                    headers: { Authorization: `Bearer ${token}` }
                });
                
                const from = detail.data.from?.address?.toLowerCase() || '';
                const subject = detail.data.subject?.toLowerCase() || '';

                if (from.includes('discord') && (subject.includes('verify') || subject.includes('confirm'))) {
                    const match = (detail.data.text || detail.data.html).match(/https:\/\/discord\.com\/verify\?token=[^"'\s]+/);
                    if (match) return match[0];
                }
            }
            await new Promise(r => setTimeout(r, 5000));
        }
        return null;
    }
}

class DiscordRegisterPage {
    constructor(browser, page) {
        this.browser = browser;
        this.page = page;
        this.capturedToken = null;
        this.apiResponse = null;
        this.setupRequestInterception();
    }

    setupRequestInterception() {
        this.page.on('request', (request) => {
            const url = request.url();
            if (url.includes('discord.com/api/v9/auth/register') || url.includes('discord.com/api/v9/users')) {
                console.log(chalk.cyan(`[REQUEST] ${url}`));
                this.captureRequest = request;
            }
        });

        this.page.on('response', async (response) => {
            const url = response.url();
            if (url.includes('discord.com/api/v9/auth/register') || url.includes('discord.com/api/v9/users')) {
                console.log(chalk.cyan(`[RESPONSE] ${url} - Status: ${response.status()}`));
                
                try {
                    const body = await response.json();
                    this.apiResponse = body;
                    
                    if (body.token) {
                        this.capturedToken = body.token;
                        console.log(chalk.green.bold(`[✓✓✓] TOKEN CAPTURED FROM API! [✓✓✓]`));
                    }
                } catch (e) {}
            }
        });
    }

    static async create() {
        const browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--window-size=1366,768'
            ]
        });
        const page = await browser.newPage();
        await page.setViewport({ width: 1366, height: 768 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        return new DiscordRegisterPage(browser, page);
    }

    async navigate() {
        await this.page.goto('https://discord.com/register', { 
            waitUntil: 'networkidle0', 
            timeout: 60000 
        });
        await this.delay(2000, 3000);
    }

    async fillForm(data) {
        console.log(chalk.blue('[+] Filling form with human-like behavior...'));
        
        // Use more reliable selectors and human-like typing
        const fillField = async (selector, value) => {
            try {
                const el = await this.page.waitForSelector(selector, { visible: true, timeout: 5000 });
                await el.click({ clickCount: 3 });
                await this.page.keyboard.press('Backspace');
                
                // Type with realistic delays
                for (const char of value) {
                    await this.page.keyboard.type(char, { delay: Math.random() * 100 + 50 });
                    if (Math.random() > 0.8) await this.delay(100, 300); // occasional pause
                }
                
                await this.delay(200, 500);
                return true;
            } catch (e) {
                return false;
            }
        };

        // Try multiple selectors for each field
        const emailFilled = await fillField('input[type="email"]', data.email) || 
                           await fillField('input[name="email"]', data.email);
        
        const usernameFilled = await fillField('input[name="username"]', data.username) ||
                              await fillField('input[placeholder*="username" i]', data.username);
        
        const passwordFilled = await fillField('input[type="password"]', data.password) ||
                              await fillField('input[name="password"]', data.password);

        if (!emailFilled || !usernameFilled || !passwordFilled) {
            throw new Error('Failed to fill all fields');
        }

        // Fill DOB
        await this.fillDOB(data.month, data.day, data.year);
        
        // Check ToS
        await this.page.evaluate(() => {
            document.querySelectorAll('input[type="checkbox"]').forEach(cb => {
                if (!cb.checked) {
                    cb.click();
                    cb.dispatchEvent(new Event('change', { bubbles: true }));
                }
            });
        });

        await this.delay(1000, 2000);
        console.log(chalk.green('[+] Form filled'));
    }

    async fillDOB(month, day, year) {
        try {
            // Find all dropdowns
            const dropdowns = await this.page.$$('div[role="button"][aria-haspopup="listbox"], div[class*="select"]');
            
            if (dropdowns.length >= 3) {
                // Month
                await dropdowns[0].click();
                await this.delay(500, 800);
                await this.page.evaluate((m) => {
                    document.querySelectorAll('[role="option"]').forEach(opt => {
                        if (opt.textContent.trim() === m) opt.click();
                    });
                }, month);
                await this.delay(500, 800);

                // Day
                await dropdowns[1].click();
                await this.delay(500, 800);
                await this.page.evaluate((d) => {
                    document.querySelectorAll('[role="option"]').forEach(opt => {
                        if (opt.textContent.trim() === d) opt.click();
                    });
                }, day);
                await this.delay(500, 800);

                // Year
                await dropdowns[2].click();
                await this.delay(500, 800);
                await this.page.evaluate((y) => {
                    document.querySelectorAll('[role="option"]').forEach(opt => {
                        if (opt.textContent.trim() === y) opt.click();
                    });
                }, year);
            }
        } catch (e) {
            console.log(chalk.yellow(`[Warning] DOB fill: ${e.message}`));
        }
    }

    async submitAndSolveCaptcha(solver) {
        console.log(chalk.blue('[+] Submitting form...'));
        
        // Take screenshot before
        await this.page.screenshot({ path: 'before_submit.png' });
        
        // Try multiple submission methods
        let submitted = false;
        
        // Method 1: Find and click the actual submit button by text
        submitted = await this.page.evaluate(() => {
            const allElements = document.querySelectorAll('button, div[role="button"]');
            for (const el of allElements) {
                const text = el.textContent.toLowerCase().trim();
                // Discord uses "Continue" or "Register"
                if ((text === 'continue' || text === 'register' || text === 'sign up') && !el.disabled) {
                    // Scroll into view
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    
                    // Multiple click attempts
                    setTimeout(() => el.click(), 100);
                    setTimeout(() => {
                        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                    }, 200);
                    
                    return true;
                }
            }
            return false;
        });

        if (!submitted) {
            // Method 2: Press Enter on last field
            await this.page.keyboard.press('Tab'); // Move to button
            await this.delay(200, 400);
            await this.page.keyboard.press('Enter');
        }

        await this.delay(3000, 5000);

        // Check for captcha
        const hasCaptcha = await this.page.$('iframe[src*="hcaptcha"]') !== null;
        
        if (hasCaptcha) {
            console.log(chalk.yellow('[!] Captcha detected!'));
            
            const siteKey = await this.page.evaluate(() => {
                return document.querySelector('[data-sitekey]')?.getAttribute('data-sitekey') || 
                       'f5561ba9-8f1e-40ca-9b5b-a0b3f719ef34';
            });

            const solution = await solver.solveHcaptcha('https://discord.com/register', siteKey);
            
            // Inject solution properly
            await this.page.evaluate((token) => {
                // Fill textarea
                document.querySelectorAll('textarea').forEach(ta => {
                    if (ta.name.includes('h-captcha') || ta.id.includes('h-captcha')) {
                        ta.value = token;
                        ta.innerHTML = token;
                        ['focus', 'input', 'change', 'blur'].forEach(evt => {
                            ta.dispatchEvent(new Event(evt, { bubbles: true }));
                        });
                    }
                });
                
                // Trigger hcaptcha callback if exists
                const hcaptchaDiv = document.querySelector('.h-captcha');
                if (hcaptchaDiv) {
                    const callback = hcaptchaDiv.getAttribute('data-callback');
                    if (callback && window[callback]) {
                        window[callback](token);
                    }
                }
                
                // Also try to find any callback in page scripts
                for (const key in window) {
                    if (typeof window[key] === 'function' && 
                        (key.includes('callback') || key.includes('hcaptcha'))) {
                        try { window[key](token); } catch(e) {}
                    }
                }
            }, solution);

            await this.delay(2000, 3000);

            // Submit again after captcha
            await this.page.evaluate(() => {
                const btn = Array.from(document.querySelectorAll('button')).find(b => 
                    b.textContent.toLowerCase().includes('continue') && !b.disabled
                );
                if (btn) {
                    btn.scrollIntoView();
                    btn.click();
                }
            });
        }

        // Wait for API response with extended timeout
        console.log(chalk.blue('[+] Waiting for Discord API response...'));
        
        for (let i = 0; i < 40; i++) {
            await this.delay(2000, 3000);
            
            // Check if we got API response
            if (this.capturedToken) {
                console.log(chalk.green.bold(`[✓✓✓] SUCCESS! Token captured! [✓✓✓]`));
                return this.capturedToken;
            }
            
            // Check URL change
            const url = this.page.url();
            if (url.includes('/channels') || url.includes('/app')) {
                console.log(chalk.green.bold(`[✓✓✓] SUCCESS! Redirected to app! [✓✓✓]`));
                return await this.getTokenFromStorage();
            }
            
            // Check for errors
            const errorText = await this.page.evaluate(() => {
                const errors = document.querySelectorAll('[class*="error"], [class*="message"], [class*="alert"]');
                for (const err of errors) {
                    const text = err.textContent;
                    if (text && text.length > 3 && !text.includes('available')) return text;
                }
                return null;
            });
            
            if (errorText) {
                console.log(chalk.red(`[Page Error]: ${errorText.slice(0, 150)}`));
            }
        }

        // If no token but we have API response, maybe it succeeded
        if (this.apiResponse) {
            console.log(chalk.yellow(`[API Response]: ${JSON.stringify(this.apiResponse).slice(0, 200)}`));
        }

        return null;
    }

    async getTokenFromStorage() {
        try {
            const token = await this.page.evaluate(() => {
                return window.localStorage?.getItem('token')?.replace(/"/g, '') ||
                       document.cookie.match(/token=([^;]+)/)?.[1];
            });
            return token || 'ACCOUNT_CREATED_NO_TOKEN';
        } catch (e) {
            return 'ACCOUNT_CREATED_NO_TOKEN';
        }
    }

    async verifyEmail(token, verifyUrl) {
        try {
            const urlToken = new URL(verifyUrl).searchParams.get('token');
            if (!urlToken) return false;
            
            const res = await axios.post(
                'https://discord.com/api/v9/auth/verify',
                { token: urlToken },
                { headers: { Authorization: token } }
            );
            return res.status === 200 || res.status === 204;
        } catch (err) {
            return false;
        }
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
        this.metrics = { attempts: 0, success: 0, fail: 0 };
    }

    async generate() {
        this.metrics.attempts++;
        let page = null;
        let email = null;

        try {
            const balance = await this.captchaSolver.getBalance();
            console.log(chalk.blue(`[AntiCaptcha] Balance: $${balance}`));
            if (balance < 0.002) throw new Error('Balance too low');

            email = await this.emailProvider.createAccount();
            page = await DiscordRegisterPage.create();
            
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

            // SUCCESS OUTPUT
            console.log(chalk.green.bold(`\n╔════════════════════════════════════════════════════════════╗`));
            console.log(chalk.green.bold(`║       [✓✓✓] ACCOUNT CREATED SUCCESSFULLY! [✓✓✓]           ║`));
            console.log(chalk.green.bold(`╠════════════════════════════════════════════════════════════╣`));
            console.log(chalk.green(`║  Email:    ${email.email.padEnd(45)}║`));
            console.log(chalk.green(`║  Password: ${email.password.padEnd(45)}║`));
            
            if (token !== 'ACCOUNT_CREATED_NO_TOKEN') {
                console.log(chalk.green(`║  Token:    ${token.slice(0, 40).padEnd(45)}║`));
            } else {
                console.log(chalk.yellow(`║  Token:    NOT CAPTURED                                  ║`));
            }
            
            console.log(chalk.green.bold(`╚════════════════════════════════════════════════════════════╝\n`));

            let verified = false;
            try {
                const verifyUrl = await this.emailProvider.getVerificationEmail(email.token, 60000);
                if (verifyUrl && token !== 'ACCOUNT_CREATED_NO_TOKEN') {
                    verified = await page.verifyEmail(token, verifyUrl);
                }
            } catch (e) {}

            await this.save(email, token, verified);
            this.metrics.success++;
            
            console.log(chalk.green.bold(`[✓✓✓] SAVED TO ${verified ? 'verified.txt' : 'unverified.txt'} [✓✓✓]`));
            
            return { success: true, token, verified, email: email.email };

        } catch (err) {
            this.metrics.fail++;
            console.log(chalk.red(`[Error] ${err.message}`));
            throw err;
        } finally {
            if (page) await page.close();
        }
    }

    genUsername() {
        const adj = ['Shadow', 'Silent', 'Dark', 'Ghost', 'Cyber', 'Neo', 'Tech'][Math.floor(Math.random() * 7)];
        const noun = ['Hunter', 'Wraith', 'Ninja', 'Coder', 'Punk', 'Runner'][Math.floor(Math.random() * 6)];
        return `${adj}${noun}${Math.floor(Math.random() * 99999)}`;
    }

    randMonth() {
        const months = ['January', 'February', 'March', 'April', 'May', 'June', 
                       'July', 'August', 'September', 'October', 'November', 'December'];
        return months[Math.floor(Math.random() * 12)];
    }

    async save(data, token, verified) {
        const line = `${data.email}:${data.password}:${token || 'NO_TOKEN'}\n`;
        await fs.appendFile(verified ? 'verified.txt' : 'unverified.txt', line);
    }

    getMetrics() {
        return { ...this.metrics };
    }
}

async function main() {
    console.log(chalk.green.bold('[+] Starting Discord Account Generator...'));
    
    const gen = new AccountGenerator({
        emailProvider: new MailTmProvider(),
        captchaSolver: new AntiCaptchaSolver(CONFIG.antiCaptchaKey)
    });

    try {
        const result = await gen.generate();
        console.log(chalk.blue(`[Metrics] Success: ${gen.getMetrics().success}, Fail: ${gen.getMetrics().fail}`));
    } catch (err) {
        console.error(chalk.red(`[Failed] ${err.message}`));
        console.log(chalk.blue(`[Metrics] Success: ${gen.getMetrics().success}, Fail: ${gen.getMetrics().fail}`));
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
