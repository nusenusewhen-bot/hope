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
        this.registerResponse = null;
        this.setupRequestInterception();
    }

    setupRequestInterception() {
        this.page.on('request', (request) => {
            const url = request.url();
            if (url.includes('discord.com/api/v9/auth/register')) {
                console.log(chalk.yellow(`[REGISTER REQUEST] ${request.method()} ${url}`));
                this.lastRegisterRequest = request;
            }
        });

        this.page.on('response', async (response) => {
            const url = response.url();
            if (url.includes('discord.com/api/v9/auth/register')) {
                const status = response.status();
                console.log(chalk.yellow(`[REGISTER RESPONSE] Status: ${status}`));
                this.registerResponse = { status, url };
                
                try {
                    const body = await response.json();
                    console.log(chalk.yellow(`[REGISTER BODY]: ${JSON.stringify(body).slice(0, 300)}`));
                    
                    if (body.token) {
                        this.capturedToken = body.token;
                        console.log(chalk.green.bold(`[✓✓✓] TOKEN CAPTURED! [✓✓✓]`));
                    }
                } catch (e) {
                    const text = await response.text().catch(() => '');
                    console.log(chalk.yellow(`[REGISTER TEXT]: ${text.slice(0, 200)}`));
                }
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
        await this.delay(3000, 5000); // Wait longer for rate limit cooldown
    }

    async fillForm(data) {
        console.log(chalk.blue('[+] Filling form...'));
        
        await this.fillField('input[type="email"]', data.email);
        await this.fillField('input[name="username"]', data.username);
        await this.fillField('input[type="password"]', data.password);
        await this.fillDOB(data.month, data.day, data.year);
        
        // Check ToS
        await this.page.evaluate(() => {
            document.querySelectorAll('input[type="checkbox"]').forEach(cb => {
                if (!cb.checked) cb.click();
            });
        });

        await this.delay(1000, 2000);
        console.log(chalk.green('[+] Form filled'));
    }

    async fillField(selector, value) {
        try {
            const el = await this.page.waitForSelector(selector, { visible: true, timeout: 5000 });
            await el.click({ clickCount: 3 });
            await this.page.keyboard.press('Backspace');
            await this.page.keyboard.type(value, { delay: 50 });
            await this.delay(200, 500);
        } catch (e) {
            console.log(chalk.yellow(`[Failed ${selector}]: ${e.message}`));
        }
    }

    async fillDOB(month, day, year) {
        try {
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
        } catch (e) {
            console.log(chalk.yellow(`[DOB Error] ${e.message}`));
        }
    }

    async submitAndSolveCaptcha(solver) {
        console.log(chalk.blue('[+] Submitting form...'));
        
        // Click Create Account button
        const clicked = await this.page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
            
            for (const btn of buttons) {
                const text = btn.textContent.trim().toLowerCase();
                if (text.includes('create account') && !btn.disabled) {
                    btn.scrollIntoView({ behavior: 'instant', block: 'center' });
                    btn.click();
                    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                    return { success: true, text: text };
                }
            }
            return { success: false };
        });
        
        console.log(chalk.blue(`[CLICK RESULT]: ${JSON.stringify(clicked)}`));
        await this.delay(3000, 5000);

        // Handle rate limit (429) - wait and retry
        if (this.registerResponse?.status === 429) {
            console.log(chalk.yellow('[!] Rate limited (429), waiting 10s...'));
            await this.delay(10000, 15000);
            
            // Retry submission
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
        }

        // Check for captcha
        const hasCaptcha = await this.page.$('iframe[src*="hcaptcha"]') !== null;
        console.log(chalk.blue(`[+] Captcha present: ${hasCaptcha}`));

        if (hasCaptcha) {
            console.log(chalk.yellow('[!] Solving captcha...'));
            
            const siteKey = await this.page.evaluate(() => {
                return document.querySelector('[data-sitekey]')?.getAttribute('data-sitekey') || 
                       'f5561ba9-8f1e-40ca-9b5b-a0b3f719ef34';
            });

            const solution = await solver.solveHcaptcha('https://discord.com/register', siteKey);
            
            // Inject solution
            await this.page.evaluate((token) => {
                // Fill hCaptcha response
                document.querySelectorAll('textarea').forEach(ta => {
                    if (ta.name.includes('h-captcha') || ta.id.includes('h-captcha')) {
                        ta.value = token;
                        ta.innerHTML = token;
                        ['focus', 'input', 'change', 'blur'].forEach(evt => {
                            ta.dispatchEvent(new Event(evt, { bubbles: true }));
                        });
                    }
                });
                
                // Trigger any callbacks
                const hcaptchaDiv = document.querySelector('.h-captcha');
                if (hcaptchaDiv) {
                    const callback = hcaptchaDiv.getAttribute('data-callback');
                    if (callback && window[callback]) {
                        window[callback](token);
                    }
                }
                
                // Alternative: try to find and call React props
                const reactKey = Object.keys(document.querySelector('.h-captcha') || {}).find(k => k.startsWith('__react'));
                if (reactKey) {
                    const reactProps = document.querySelector('.h-captcha')[reactKey];
                    if (reactProps?.children?.props?.onVerify) {
                        reactProps.children.props.onVerify(token);
                    }
                }
            }, solution);

            console.log(chalk.green('[+] Captcha solution injected'));
            await this.delay(2000, 3000);

            // THE KEY FIX: Click Create Account AGAIN after captcha
            console.log(chalk.blue('[+] Re-submitting after captcha...'));
            
            const reclickResult = await this.page.evaluate(() => {
                const btn = Array.from(document.querySelectorAll('button')).find(b => 
                    b.textContent.toLowerCase().includes('create account') && !b.disabled
                );
                
                if (btn) {
                    console.log('[EVAL] Re-clicking Create Account');
                    btn.scrollIntoView({ behavior: 'instant', block: 'center' });
                    
                    // Multiple click attempts
                    btn.click();
                    setTimeout(() => btn.click(), 100);
                    setTimeout(() => btn.dispatchEvent(new MouseEvent('click', { bubbles: true })), 200);
                    
                    return { clicked: true, text: btn.textContent };
                }
                return { clicked: false };
            });
            
            console.log(chalk.blue(`[RECLICK RESULT]: ${JSON.stringify(reclickResult)}`));
            
            if (!reclickResult.clicked) {
                // Fallback: try pressing Enter
                await this.page.keyboard.press('Tab');
                await this.delay(200, 400);
                await this.page.keyboard.press('Enter');
            }
        }

        // Wait for success with extended timeout
        console.log(chalk.blue('[+] Waiting for registration to complete...'));
        
        for (let i = 0; i < 40; i++) {
            await this.delay(2000, 3000);
            
            const url = this.page.url();
            const hasToken = !!this.capturedToken;
            
            console.log(chalk.blue(`[Check ${i+1}/40] URL: ${url}, Token: ${hasToken ? 'YES' : 'NO'}`));
            
            // SUCCESS: Token captured
            if (this.capturedToken) {
                console.log(chalk.green.bold(`[✓✓✓] SUCCESS! Token captured! [✓✓✓]`));
                return this.capturedToken;
            }
            
            // SUCCESS: Redirected to app
            if (url.includes('/channels') || url.includes('/app')) {
                console.log(chalk.green.bold(`[✓✓✓] SUCCESS! Redirected to app! [✓✓✓]`));
                return await this.getTokenFromStorage();
            }
            
            // Check for error messages on page
            const errorText = await this.page.evaluate(() => {
                const errors = document.querySelectorAll('[class*="error"], [class*="message"]');
                for (const err of errors) {
                    const text = err.textContent;
                    if (text && text.length > 3 && !text.includes('available')) return text;
                }
                return null;
            });
            
            if (errorText) {
                console.log(chalk.red(`[PAGE ERROR]: ${errorText.slice(0, 150)}`));
            }
        }

        return null;
    }

    async getTokenFromStorage() {
        try {
            const token = await this.page.evaluate(() => {
                return window.localStorage?.getItem('token')?.replace(/"/g, '');
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
            
            if (!token) throw new Error('Registration failed - no token obtained');

            console.log(chalk.green.bold(`\n╔════════════════════════════════════════════════════════════╗`));
            console.log(chalk.green.bold(`║       [✓✓✓] ACCOUNT CREATED SUCCESSFULLY! [✓✓✓]           ║`));
            console.log(chalk.green.bold(`╠════════════════════════════════════════════════════════════╣`));
            console.log(chalk.green(`║  Email:    ${email.email.padEnd(45)}║`));
            console.log(chalk.green(`║  Password: ${email.password.padEnd(45)}║`));
            console.log(chalk.green(`║  Token:    ${token.slice(0, 40).padEnd(45)}║`));
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
        const adj = ['Shadow', 'Silent', 'Dark', 'Ghost', 'Cyber', 'Neo'][Math.floor(Math.random() * 6)];
        const noun = ['Hunter', 'Wraith', 'Ninja', 'Coder', 'Punk'][Math.floor(Math.random() * 5)];
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
