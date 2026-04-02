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
        this.setupRequestInterception();
    }

    setupRequestInterception() {
        // Log ALL requests
        this.page.on('request', (request) => {
            const url = request.url();
            if (url.includes('discord.com/api')) {
                console.log(chalk.cyan(`[REQUEST] ${request.method()} ${url}`));
                if (url.includes('register') || url.includes('users')) {
                    console.log(chalk.yellow(`[REGISTER REQUEST DETECTED] ${url}`));
                    console.log(chalk.yellow(`[HEADERS]: ${JSON.stringify(request.headers()).slice(0, 200)}`));
                }
            }
        });

        // Log ALL responses
        this.page.on('response', async (response) => {
            const url = response.url();
            if (url.includes('discord.com/api')) {
                const status = response.status();
                console.log(chalk.cyan(`[RESPONSE] ${status} ${url}`));
                
                if (url.includes('register') || url.includes('users')) {
                    console.log(chalk.green(`[REGISTER RESPONSE] Status: ${status}`));
                    try {
                        const body = await response.json();
                        console.log(chalk.green(`[BODY]: ${JSON.stringify(body).slice(0, 300)}`));
                        if (body.token) {
                            this.capturedToken = body.token;
                            console.log(chalk.green.bold(`[✓✓✓] TOKEN CAPTURED! [✓✓✓]`));
                        }
                    } catch (e) {
                        console.log(chalk.yellow(`[Response not JSON]`));
                    }
                }
            }
        });

        // Log console messages from page
        this.page.on('console', (msg) => {
            console.log(chalk.gray(`[PAGE CONSOLE] ${msg.type()}: ${msg.text().slice(0, 150)}`));
        });

        // Log page errors
        this.page.on('pageerror', (err) => {
            console.log(chalk.red(`[PAGE ERROR] ${err.message}`));
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
        console.log(chalk.blue('[+] Navigating to Discord register...'));
        await this.page.goto('https://discord.com/register', { 
            waitUntil: 'networkidle0', 
            timeout: 60000 
        });
        
        // Log page info
        const url = this.page.url();
        const title = await this.page.title();
        console.log(chalk.blue(`[+] Page loaded: ${url}`));
        console.log(chalk.blue(`[+] Title: ${title}`));
        
        // Check if form exists
        const formExists = await this.page.$('form') !== null;
        const inputs = await this.page.$$('input');
        console.log(chalk.blue(`[+] Form exists: ${formExists}, Inputs found: ${inputs.length}`));
        
        await this.delay(2000, 3000);
    }

    async fillForm(data) {
        console.log(chalk.blue('[+] Filling form...'));
        
        // Detailed field detection
        const fields = await this.page.evaluate(() => {
            const inputs = Array.from(document.querySelectorAll('input'));
            return inputs.map(i => ({
                type: i.type,
                name: i.name,
                placeholder: i.placeholder,
                id: i.id,
                class: i.className?.slice(0, 50),
                value: i.value?.slice(0, 20)
            }));
        });
        console.log(chalk.blue(`[DETECTED FIELDS]: ${JSON.stringify(fields, null, 2)}`));

        // Fill with detailed logging
        const fillField = async (selectors, value, name) => {
            for (const selector of selectors) {
                try {
                    const el = await this.page.$(selector);
                    if (el) {
                        console.log(chalk.blue(`[+] Found ${name} with selector: ${selector}`));
                        await el.click({ clickCount: 3 });
                        await this.page.keyboard.press('Backspace');
                        
                        for (const char of value) {
                            await this.page.keyboard.type(char, { delay: Math.random() * 50 + 30 });
                        }
                        
                        // Verify fill
                        const filledValue = await el.evaluate(e => e.value);
                        console.log(chalk.blue(`[+] ${name} filled: ${filledValue === value ? 'SUCCESS' : 'MISMATCH'}`));
                        
                        await this.delay(200, 500);
                        return true;
                    }
                } catch (e) {
                    console.log(chalk.yellow(`[Failed ${name}] ${selector}: ${e.message}`));
                }
            }
            return false;
        };

        const emailOk = await fillField(['input[type="email"]', 'input[name="email"]'], data.email, 'Email');
        const usernameOk = await fillField(['input[name="username"]', 'input[placeholder*="username" i]'], data.username, 'Username');
        const passwordOk = await fillField(['input[type="password"]', 'input[name="password"]'], data.password, 'Password');

        if (!emailOk || !usernameOk || !passwordOk) {
            throw new Error(`Field fill failed: email=${emailOk}, username=${usernameOk}, password=${passwordOk}`);
        }

        // DOB
        await this.fillDOB(data.month, data.day, data.year);
        
        // ToS
        await this.page.evaluate(() => {
            document.querySelectorAll('input[type="checkbox"]').forEach(cb => {
                if (!cb.checked) cb.click();
            });
        });

        await this.delay(1000, 2000);
        
        // Final form state
        const finalState = await this.page.evaluate(() => {
            return Array.from(document.querySelectorAll('input')).map(i => ({
                name: i.name,
                value: i.value?.slice(0, 20),
                type: i.type
            }));
        });
        console.log(chalk.blue(`[FINAL FORM STATE]: ${JSON.stringify(finalState, null, 2)}`));
        
        console.log(chalk.green('[+] Form filled'));
    }

    async fillDOB(month, day, year) {
        console.log(chalk.blue(`[+] Filling DOB: ${month}/${day}/${year}`));
        
        try {
            const dropdowns = await this.page.$$('div[role="button"][aria-haspopup="listbox"]');
            console.log(chalk.blue(`[+] Found ${dropdowns.length} dropdowns`));
            
            if (dropdowns.length >= 3) {
                for (let i = 0; i < 3; i++) {
                    const val = [month, day, year][i];
                    console.log(chalk.blue(`[+] Setting dropdown ${i} to ${val}`));
                    
                    await dropdowns[i].click();
                    await this.delay(500, 800);
                    
                    const clicked = await this.page.evaluate((v) => {
                        const opts = document.querySelectorAll('[role="option"]');
                        for (const opt of opts) {
                            if (opt.textContent.trim() === v) {
                                opt.click();
                                return true;
                            }
                        }
                        return false;
                    }, val);
                    
                    console.log(chalk.blue(`[+] Dropdown ${i} selection: ${clicked ? 'SUCCESS' : 'FAILED'}`));
                    await this.delay(500, 800);
                }
            }
        } catch (e) {
            console.log(chalk.yellow(`[DOB Error] ${e.message}`));
        }
    }

    async submitAndSolveCaptcha(solver) {
        console.log(chalk.blue('[+] Preparing to submit...'));
        
        // Find all buttons before submission
        const buttonsBefore = await this.page.evaluate(() => {
            return Array.from(document.querySelectorAll('button, div[role="button"]')).map(b => ({
                text: b.textContent.trim(),
                disabled: b.disabled,
                type: b.type,
                tag: b.tagName,
                visible: b.offsetParent !== null
            }));
        });
        console.log(chalk.blue(`[BUTTONS FOUND]: ${JSON.stringify(buttonsBefore, null, 2)}`));

        // Take screenshot
        await this.page.screenshot({ path: 'before_submit.png' });
        console.log(chalk.blue('[+] Screenshot saved: before_submit.png'));

        // Attempt submission with detailed logging
        console.log(chalk.blue('[+] Attempting to click submit button...'));
        
        const clickResult = await this.page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
            console.log(`[EVAL] Found ${buttons.length} buttons`);
            
            for (const btn of buttons) {
                const text = btn.textContent.trim().toLowerCase();
                console.log(`[EVAL] Button: "${text}", disabled: ${btn.disabled}, visible: ${btn.offsetParent !== null}`);
                
                if ((text === 'continue' || text === 'register' || text.includes('sign up')) && !btn.disabled) {
                    console.log(`[EVAL] Clicking button: "${text}"`);
                    
                    // Scroll into view
                    btn.scrollIntoView({ behavior: 'instant', block: 'center' });
                    
                    // Click multiple ways
                    const click1 = btn.click();
                    const click2 = btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                    
                    return { 
                        success: true, 
                        text: text,
                        clicks: { native: !!click1, event: !!click2 }
                    };
                }
            }
            return { success: false, reason: 'No suitable button found' };
        });
        
        console.log(chalk.blue(`[CLICK RESULT]: ${JSON.stringify(clickResult)}`));

        await this.delay(3000, 5000);

        // Check what happened
        const urlAfterClick = this.page.url();
        console.log(chalk.blue(`[+] URL after click: ${urlAfterClick}`));

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
            
            await this.page.evaluate((token) => {
                document.querySelectorAll('textarea').forEach(ta => {
                    if (ta.name.includes('h-captcha') || ta.id.includes('h-captcha')) {
                        ta.value = token;
                        ta.innerHTML = token;
                        ['focus', 'input', 'change', 'blur'].forEach(evt => {
                            ta.dispatchEvent(new Event(evt, { bubbles: true }));
                        });
                    }
                });
            }, solution);

            await this.delay(2000, 3000);
            
            // Click submit again
            await this.page.evaluate(() => {
                const btn = Array.from(document.querySelectorAll('button')).find(b => 
                    b.textContent.toLowerCase().includes('continue') && !b.disabled
                );
                if (btn) btn.click();
            });
        }

        // Wait for API with detailed logging
        console.log(chalk.blue('[+] Waiting for API response (60s max)...'));
        
        for (let i = 0; i < 30; i++) {
            await this.delay(2000, 3000);
            
            const url = this.page.url();
            console.log(chalk.blue(`[Check ${i+1}/30] URL: ${url}, Token: ${this.capturedToken ? 'YES' : 'NO'}`));
            
            if (this.capturedToken) {
                console.log(chalk.green.bold(`[✓✓✓] SUCCESS! Token captured! [✓✓✓]`));
                return this.capturedToken;
            }
            
            if (url.includes('/channels') || url.includes('/app')) {
                console.log(chalk.green.bold(`[✓✓✓] SUCCESS! Redirected! [✓✓✓]`));
                return await this.getTokenFromStorage();
            }
        }

        // Final diagnostics
        console.log(chalk.red('[DIAGNOSTICS] No API response detected'));
        const finalButtons = await this.page.evaluate(() => {
            return Array.from(document.querySelectorAll('button')).map(b => ({
                text: b.textContent.trim(),
                disabled: b.disabled
            }));
        });
        console.log(chalk.red(`[Final buttons]: ${JSON.stringify(finalButtons)}`));
        
        const errorMsgs = await this.page.evaluate(() => {
            return Array.from(document.querySelectorAll('[class*="error"], [class*="message"]')).map(e => e.textContent);
        });
        console.log(chalk.red(`[Error messages]: ${JSON.stringify(errorMsgs)}`));

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
            
            if (!token) throw new Error('No token obtained - check logs above for API activity');

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
    console.log(chalk.green.bold('[+] Starting Discord Account Generator with FULL LOGGING...'));
    
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
