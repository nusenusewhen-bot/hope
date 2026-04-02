const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const fs = require('fs').promises;
const chalk = require('chalk');
const { z } = require('zod');

puppeteer.use(StealthPlugin());

const ConfigSchema = z.object({
    captcha: z.object({
        antiCaptchaKey: z.string(),
        geminiKey: z.string().optional(),
        groqKey: z.string().optional()
    })
});

const CONFIG = ConfigSchema.parse({
    captcha: {
        antiCaptchaKey: process.env.ANTICAPTCHA_KEY || '373271de10fac6ff5aa75a2928acd339',
        geminiKey: process.env.GEMINI_KEY || '',
        groqKey: process.env.GROQ_KEY || ''
    }
});

class RetryWithBackoff {
    constructor(maxAttempts = 3, initialDelay = 1000) {
        this.maxAttempts = maxAttempts;
        this.initialDelay = initialDelay;
    }

    async execute(fn, context) {
        let delay = this.initialDelay;
        for (let i = 1; i <= this.maxAttempts; i++) {
            try {
                return await fn();
            } catch (err) {
                if (i === this.maxAttempts) throw err;
                console.log(chalk.yellow(`[Retry ${i}/${this.maxAttempts}] ${context}: ${err.message}`));
                await new Promise(r => setTimeout(r, delay));
                delay *= 2;
            }
        }
    }
}

class CircuitBreaker {
    constructor(name, threshold = 5, timeout = 60000) {
        this.name = name;
        this.threshold = threshold;
        this.timeout = timeout;
        this.failures = 0;
        this.state = 'CLOSED';
        this.lastFailure = null;
    }

    async execute(fn) {
        if (this.state === 'OPEN') {
            if (Date.now() - this.lastFailure > this.timeout) {
                this.state = 'HALF_OPEN';
            } else {
                throw new Error(`Circuit ${this.name} is OPEN`);
            }
        }

        try {
            const result = await fn();
            this.onSuccess();
            return result;
        } catch (err) {
            this.onFailure();
            throw err;
        }
    }

    onSuccess() {
        this.failures = 0;
        this.state = 'CLOSED';
    }

    onFailure() {
        this.failures++;
        this.lastFailure = Date.now();
        if (this.failures >= this.threshold) this.state = 'OPEN';
    }
}

class MailTmProvider {
    constructor() {
        this.baseUrl = 'https://api.mail.tm';
        this.retry = new RetryWithBackoff();
        this.circuit = new CircuitBreaker('mailtm');
    }

    async createAccount() {
        return this.circuit.execute(() => this.retry.execute(async () => {
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
        }, 'email.create'));
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

class AntiCaptchaSolver {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.baseUrl = 'https://api.anti-captcha.com';
        this.retry = new RetryWithBackoff(5, 2000);
        this.circuit = new CircuitBreaker('anticaptcha', 3, 60000);
    }

    async solveHcaptcha(pageUrl, siteKey) {
        return this.circuit.execute(() => this.retry.execute(async () => {
            console.log(chalk.blue(`[AntiCaptcha] Creating task for ${pageUrl}`));
            
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

            return this.getTaskResult(taskId);
        }, 'anticaptcha.solve'));
    }

    async getTaskResult(taskId, maxAttempts = 60, interval = 5000) {
        for (let i = 0; i < maxAttempts; i++) {
            await new Promise(r => setTimeout(r, interval));
            
            const result = await axios.post(`${this.baseUrl}/getTaskResult`, {
                clientKey: this.apiKey,
                taskId: taskId
            }, { timeout: 30000 });

            console.log(chalk.blue(`[AntiCaptcha] Polling ${i + 1}/${maxAttempts}: ${result.data.status}`));

            if (result.data.status === 'ready') {
                if (result.data.errorId !== 0) {
                    throw new Error(`Task failed: ${result.data.errorDescription}`);
                }
                console.log(chalk.green(`[AntiCaptcha] Solution received!`));
                return result.data.solution.gRecaptchaResponse;
            }
        }
        throw new Error('AntiCaptcha polling timeout');
    }

    async getBalance() {
        const res = await axios.post(`${this.baseUrl}/getBalance`, {
            clientKey: this.apiKey
        });
        return res.data.balance;
    }
}

class CaptchaSolver {
    constructor() {
        this.kb = new Map();
        this.antiCaptcha = new AntiCaptchaSolver(CONFIG.captcha.antiCaptchaKey);
        this.circuitGemini = new CircuitBreaker('gemini', 3, 30000);
        this.circuitGroq = new CircuitBreaker('groq', 3, 30000);
    }

    async solve(question) {
        const q = question.toLowerCase().trim();
        if (this.kb.has(q)) return this.kb.get(q);

        const [gemini, groq] = await Promise.allSettled([
            this.circuitGemini.execute(() => this.callGemini(q)),
            this.circuitGroq.execute(() => this.callGroq(q))
        ]);

        const answer = gemini.value || groq.value || 'nee';
        this.kb.set(q, answer);
        return answer;
    }

    async callGemini(q) {
        const res = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${CONFIG.captcha.geminiKey}`,
            {
                contents: [{ parts: [{ text: `Dutch yes/no CAPTCHA. Answer ONLY 'ja' or 'nee'. Question: ${q}` }] }],
                generationConfig: { temperature: 0, maxOutputTokens: 5 }
            },
            { timeout: 10000 }
        );
        const t = res.data.candidates[0].content.parts[0].text.toLowerCase();
        if (t.includes('ja') && !t.includes('nee')) return 'ja';
        if (t.includes('nee')) return 'nee';
        return null;
    }

    async callGroq(q) {
        const res = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            {
                model: 'llama-3.3-70b-versatile',
                messages: [{ role: 'user', content: `Dutch yes/no CAPTCHA. Answer ONLY 'ja' or 'nee'. Question: ${q}` }],
                temperature: 0, max_tokens: 5
            },
            { headers: { Authorization: `Bearer ${CONFIG.captcha.groqKey}` }, timeout: 10000 }
        );
        const t = res.data.choices[0].message.content.toLowerCase();
        if (t.includes('ja') && !t.includes('nee')) return 'ja';
        if (t.includes('nee')) return 'nee';
        return null;
    }
}

class DiscordRegisterPage {
    constructor(browser, page) {
        this.browser = browser;
        this.page = page;
        this.capturedToken = null;
        this.accountCreated = false;
        this.setupRequestInterception();
    }

    setupRequestInterception() {
        this.page.on('response', async (response) => {
            const request = response.request();
            const url = request.url();
            const headers = request.headers();
            
            // Capture authorization token from API calls
            if (url.includes('discord.com/api') && headers['authorization']) {
                const auth = headers['authorization'];
                if (auth && auth.startsWith('Bearer ')) {
                    this.capturedToken = auth.replace('Bearer ', '');
                    console.log(chalk.cyan(`[+] Token captured from network request!`));
                }
            }

            // Check for successful registration response
            if (url.includes('/auth/register') || url.includes('/auth/local') || url.includes('/users')) {
                try {
                    const status = response.status();
                    const text = await response.text().catch(() => '');
                    if (status === 200 || status === 201 || status === 204) {
                        console.log(chalk.green(`[+] Registration API returned ${status} - Account created!`));
                        this.accountCreated = true;
                    }
                    if (text.includes('token') || text.includes('created')) {
                        console.log(chalk.green(`[+] Response indicates success: ${text.slice(0, 100)}`));
                        this.accountCreated = true;
                    }
                } catch (e) {}
            }
        });
    }

    static async create(config) {
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
        
        // Set realistic user agent
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        return new DiscordRegisterPage(browser, page);
    }

    async navigate() {
        await this.page.goto('https://discord.com/register', { 
            waitUntil: 'networkidle2', 
            timeout: 60000 
        });
        
        // Wait for page to fully load
        await this.delay(3000, 5000);
    }

    async fillForm(data) {
        console.log(chalk.blue('[+] Filling registration form...'));
        
        // Discord uses dynamic class names, so we use attribute selectors
        // Wait for the form container
        await this.page.waitForSelector('form, [class*="authBox"], [class*="container"]', { visible: true, timeout: 10000 });
        
        // Take screenshot to debug
        await this.page.screenshot({ path: 'before_fill.png' });
        
        // Try multiple selectors for each field
        const emailSelectors = [
            'input[type="email"]',
            'input[name="email"]',
            'input[placeholder*="email" i]',
            'input[inputmode="email"]'
        ];
        
        const usernameSelectors = [
            'input[name="username"]',
            'input[placeholder*="username" i]',
            'input[placeholder*="display name" i]'
        ];
        
        const passwordSelectors = [
            'input[type="password"]',
            'input[name="password"]',
            'input[placeholder*="password" i]'
        ];

        // Fill email
        await this.tryFillField(emailSelectors, data.email, 'Email');
        
        // Fill username
        await this.tryFillField(usernameSelectors, data.username, 'Username');
        
        // Fill password
        await this.tryFillField(passwordSelectors, data.password, 'Password');

        // Handle date of birth - Discord uses dropdowns
        await this.fillDateOfBirth(data.month, data.day, data.year);

        // Handle ToS checkbox
        await this.handleTosCheckbox();

        await this.delay(1000, 2000);
        
        await this.page.screenshot({ path: 'after_fill.png' });
        console.log(chalk.green('[+] Form filled successfully'));
    }

    async tryFillField(selectors, value, fieldName) {
        for (const selector of selectors) {
            try {
                const element = await this.page.$(selector);
                if (element) {
                    await element.click({ clickCount: 3 });
                    await this.page.keyboard.press('Backspace');
                    
                    // Type with human-like delay
                    for (const char of value) {
                        await this.page.keyboard.type(char, { delay: Math.floor(Math.random() * 50 + 30) });
                    }
                    
                    console.log(chalk.blue(`[+] Filled ${fieldName}`));
                    await this.delay(200, 500);
                    return;
                }
            } catch (e) {}
        }
        throw new Error(`Could not find ${fieldName} field`);
    }

    async fillDateOfBirth(month, day, year) {
        try {
            // Discord uses dropdowns for DOB
            const dropdowns = await this.page.$$('[role="button"], [class*="select"], select');
            
            if (dropdowns.length >= 3) {
                // Month
                await dropdowns[0].click();
                await this.delay(500, 800);
                await this.selectOption(month);
                
                // Day
                await dropdowns[1].click();
                await this.delay(500, 800);
                await this.selectOption(day);
                
                // Year
                await dropdowns[2].click();
                await this.delay(500, 800);
                await this.selectOption(year);
            } else {
                // Try alternative method - direct input if text fields exist
                const dateInputs = await this.page.$$('input[placeholder*="mm" i], input[placeholder*="dd" i], input[placeholder*="yyyy" i]');
                if (dateInputs.length === 3) {
                    await dateInputs[0].type(month);
                    await dateInputs[1].type(day);
                    await dateInputs[2].type(year);
                }
            }
            
            console.log(chalk.blue(`[+] Filled DOB: ${month}/${day}/${year}`));
        } catch (e) {
            console.log(chalk.yellow(`[Warning] DOB fill issue: ${e.message}`));
        }
    }

    async selectOption(value) {
        await this.page.evaluate((val) => {
            const options = document.querySelectorAll('[role="option"], [class*="option"], option');
            for (const opt of options) {
                if (opt.textContent.trim() === val || opt.value === val) {
                    opt.click();
                    return true;
                }
            }
            return false;
        }, value);
        await this.delay(300, 600);
    }

    async handleTosCheckbox() {
        try {
            // Look for ToS checkbox
            const checkboxes = await this.page.$$('input[type="checkbox"], [role="checkbox"]');
            for (const cb of checkboxes) {
                const isChecked = await cb.evaluate(el => el.checked);
                if (!isChecked) {
                    await cb.click();
                    console.log(chalk.blue('[+] Checked ToS checkbox'));
                    await this.delay(300, 500);
                }
            }
        } catch (e) {
            console.log(chalk.yellow(`[Warning] ToS checkbox issue: ${e.message}`));
        }
    }

    async submit() {
        console.log(chalk.blue('[+] Submitting form...'));
        
        // Try multiple button selectors
        const buttonSelectors = [
            'button[type="submit"]',
            'button[class*="button"]',
            'button:has-text("Continue")',
            'button:has-text("Register")',
            'button:has-text("Sign Up")',
            'button'
        ];

        for (const selector of buttonSelectors) {
            try {
                const buttons = await this.page.$$(selector);
                for (const btn of buttons) {
                    const text = await btn.evaluate(el => el.textContent.toLowerCase());
                    const isDisabled = await btn.evaluate(el => el.disabled);
                    
                    if (!isDisabled && (text.includes('continue') || text.includes('register') || text.includes('sign up') || text.includes('submit'))) {
                        console.log(chalk.blue(`[+] Clicking button: ${text}`));
                        
                        // Click and wait for response
                        await Promise.all([
                            btn.click(),
                            this.page.waitForResponse(
                                response => response.url().includes('discord.com/api'),
                                { timeout: 15000 }
                            ).catch(() => null)
                        ]);
                        
                        await this.delay(3000, 5000);
                        return;
                    }
                }
            } catch (e) {}
        }
        
        // Fallback: try pressing Enter
        await this.page.keyboard.press('Enter');
        await this.delay(3000, 5000);
    }

    async solveCaptcha(solver) {
        console.log(chalk.blue('[+] Checking for captcha...'));
        
        // Wait for potential captcha
        let captchaPresent = false;
        try {
            await this.page.waitForSelector('iframe[src*="hcaptcha"], iframe[src*="recaptcha"], [class*="captcha"]', { 
                visible: true, 
                timeout: 5000 
            });
            captchaPresent = true;
        } catch (e) {
            console.log(chalk.green('[+] No captcha detected immediately'));
        }
        
        if (captchaPresent) {
            console.log(chalk.yellow('[!] Captcha detected, solving...'));
            
            const siteKey = await this.page.evaluate(() => {
                const el = document.querySelector('[data-sitekey]');
                return el ? el.getAttribute('data-sitekey') : 'f5561ba9-8f1e-40ca-9b5b-a0b3f719ef34';
            });

            const token = await solver.antiCaptcha.solveHcaptcha('https://discord.com/register', siteKey);
            
            // Inject solution
            await this.page.evaluate((solution) => {
                const textareas = document.querySelectorAll('textarea[name="h-captcha-response"], textarea[id*="h-captcha-response"]');
                textareas.forEach(ta => {
                    ta.value = solution;
                    ta.innerHTML = solution;
                    ta.dispatchEvent(new Event('input', { bubbles: true }));
                    ta.dispatchEvent(new Event('change', { bubbles: true }));
                });
            }, token);
            
            console.log(chalk.green('[+] Captcha solution injected'));
            await this.delay(2000, 3000);
            
            // Submit again after captcha
            await this.submit();
        }

        // Wait for results
        console.log(chalk.blue('[+] Waiting for registration result...'));
        
        for (let i = 0; i < 20; i++) {
            const url = this.page.url();
            
            // Check if redirected to app
            if (url.includes('/channels') || url.includes('/app') || url.includes('/verify')) {
                console.log(chalk.green.bold(`[✓✓✓] SUCCESS! Redirected to: ${url} [✓✓✓]`));
                this.accountCreated = true;
                break;
            }
            
            // Check if we have token
            if (this.capturedToken) {
                console.log(chalk.green.bold(`[✓✓✓] TOKEN CAPTURED! [✓✓✓]`));
                this.accountCreated = true;
                break;
            }
            
            await this.delay(2000, 3000);
        }

        return await this.extractToken();
    }

    async extractToken() {
        // Try multiple token sources
        if (this.capturedToken) {
            console.log(chalk.green(`[+] Using network-captured token`));
            return this.capturedToken;
        }

        // Try localStorage
        try {
            const token = await this.page.evaluate(() => {
                try {
                    return window.localStorage?.getItem('token')?.replace(/"/g, '') || 
                           window.localStorage?.getItem('session')?.replace(/"/g, '');
                } catch (e) { return null; }
            });
            if (token) {
                console.log(chalk.green(`[+] Token found in localStorage`));
                this.accountCreated = true;
                return token;
            }
        } catch (e) {}

        // Check if account was created even without token
        const url = this.page.url();
        if (this.accountCreated || url.includes('discord.com/channels') || url.includes('discord.com/app')) {
            console.log(chalk.green.bold(`[✓✓✓] ACCOUNT CREATED (no token captured) [✓✓✓]`));
            return 'ACCOUNT_CREATED_NO_TOKEN';
        }

        // Check for error messages
        const errorText = await this.page.evaluate(() => {
            const errors = document.querySelectorAll('[class*="error"], [class*="message"]');
            return Array.from(errors).map(e => e.textContent).join(' ');
        });
        
        if (errorText) {
            console.log(chalk.yellow(`[Page errors]: ${errorText.slice(0, 200)}`));
        }

        return null;
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
            console.log(chalk.yellow(`[Warning] Email verification failed: ${err.message}`));
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
            const balance = await this.captchaSolver.antiCaptcha.getBalance();
            console.log(chalk.blue(`[AntiCaptcha] Balance: $${balance}`));
            
            if (balance < 0.002) {
                throw new Error('Anti-Captcha balance too low');
            }

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
            
            await page.submit();
            const token = await page.solveCaptcha(this.captchaSolver);
            
            if (!token) {
                throw new Error('No token obtained and account creation not confirmed');
            }

            // SUCCESS OUTPUT
            console.log(chalk.green.bold(`\n╔════════════════════════════════════════════════════════════╗`));
            console.log(chalk.green.bold(`║       [✓✓✓] ACCOUNT CREATED SUCCESSFULLY! [✓✓✓]           ║`));
            console.log(chalk.green.bold(`╠════════════════════════════════════════════════════════════╣`));
            console.log(chalk.green(`║  Email:    ${email.email.padEnd(45)}║`));
            console.log(chalk.green(`║  Password: ${email.password.padEnd(45)}║`));
            
            if (token !== 'ACCOUNT_CREATED_NO_TOKEN') {
                console.log(chalk.green(`║  Token:    ${token.slice(0, 40).padEnd(45)}║`));
            } else {
                console.log(chalk.yellow(`║  Token:    NOT CAPTURED (account exists but no token)     ║`));
            }
            
            console.log(chalk.green.bold(`╚════════════════════════════════════════════════════════════╝\n`));

            // Email verification
            let verified = false;
            try {
                const verifyUrl = await this.emailProvider.getVerificationEmail(email.token, 60000);
                if (verifyUrl && token !== 'ACCOUNT_CREATED_NO_TOKEN') {
                    verified = await page.verifyEmail(token, verifyUrl);
                }
            } catch (e) {}

            await this.save(email, token, verified);
            this.metrics.success++;
            
            console.log(chalk.green.bold(`[✓✓✓] SAVED TO ${verified ? 'verified.txt' : 'unverified.txt'} [✓✓✓]\n`));
            
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
        const adjectives = ['Shadow', 'Silent', 'Dark', 'Ghost', 'Cyber', 'Neo', 'Tech', 'Crypto'];
        const nouns = ['Hunter', 'Wraith', 'Ninja', 'Coder', 'Punk', 'Runner', 'Drifter', 'Ghost'];
        return `${adjectives[Math.floor(Math.random() * adjectives.length)]}${nouns[Math.floor(Math.random() * nouns.length)]}${Math.floor(Math.random() * 99999)}`;
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
    console.log(chalk.green.bold('[+] Starting Discord Account Generator with Anti-Captcha...'));
    
    const gen = new AccountGenerator({
        emailProvider: new MailTmProvider(),
        captchaSolver: new CaptchaSolver()
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
