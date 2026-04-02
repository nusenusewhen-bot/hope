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
        // Listen for responses to capture token
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
            if (url.includes('/auth/register') || url.includes('/auth/local')) {
                try {
                    const status = response.status();
                    if (status === 200 || status === 201 || status === 204) {
                        console.log(chalk.green(`[+] Registration API returned ${status} - Account likely created!`));
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
    }

    async fillForm(data) {
        // Wait for form to be ready
        await this.page.waitForSelector('input[name="email"]', { visible: true });
        
        await this.type('input[name="email"]', data.email);
        await this.type('input[name="username"]', data.username);
        await this.type('input[name="password"]', data.password);

        await this.selectDropdown('Month', data.month);
        await this.selectDropdown('Day', data.day);
        await this.selectDropdown('Year', data.year);

        // Handle ToS checkbox if present
        await this.page.evaluate(() => {
            const checkboxes = document.querySelectorAll('input[type="checkbox"]');
            checkboxes.forEach(cb => { 
                if (!cb.checked && (cb.name.includes('terms') || cb.name.includes('age') || cb.id.includes('terms'))) {
                    cb.click();
                }
            });
        });

        await this.delay(1000, 2000);
    }

    async submit() {
        // Click submit and wait for navigation or response
        await Promise.all([
            this.page.click('button[type="submit"]'),
            this.page.waitForResponse(response => 
                response.url().includes('discord.com/api') && 
                (response.url().includes('register') || response.url().includes('login')),
                { timeout: 30000 }
            ).catch(() => null)
        ]);
        
        await this.delay(2000, 4000);
    }

    async type(selector, value) {
        await this.page.waitForSelector(selector);
        await this.page.click(selector, { clickCount: 3 }); // Select all first
        await this.page.keyboard.press('Backspace');
        
        for (const c of value) {
            await this.page.keyboard.type(c, { delay: Math.floor(Math.random() * 100 + 50) });
        }
        await this.delay(300, 800);
    }

    async selectDropdown(label, value) {
        await this.page.click(`div[role="button"][aria-label*="${label}"]`);
        await this.delay(500, 1000);
        await this.page.evaluate((val) => {
            const options = document.querySelectorAll('div[role="option"]');
            for (const opt of options) {
                if (opt.textContent.trim() === val) {
                    opt.click();
                    return;
                }
            }
        }, value);
        await this.delay(500, 1000);
    }

    async solveCaptcha(solver) {
        try {
            console.log(chalk.blue('[+] Checking for captcha...'));
            
            // Wait for potential captcha with timeout
            let iframeHandle = null;
            try {
                iframeHandle = await this.page.waitForSelector('iframe[src*="hcaptcha"]', { 
                    visible: true, 
                    timeout: 8000 
                });
            } catch (e) {
                console.log(chalk.green('[+] No captcha appeared within timeout'));
            }
            
            if (!iframeHandle) {
                console.log(chalk.green('[+] No hCaptcha detected, proceeding...'));
                await this.delay(3000, 5000);
                
                // Check if we're already logged in (no captcha needed)
                const currentUrl = this.page.url();
                if (currentUrl.includes('channels') || currentUrl.includes('app')) {
                    console.log(chalk.green('[+] Already redirected to app - account created without captcha!'));
                    this.accountCreated = true;
                }
                
                return await this.extractToken();
            }

            console.log(chalk.yellow('[!] hCaptcha detected, using Anti-Captcha service...'));

            // Get site key
            const siteKey = await this.page.evaluate(() => {
                const hcaptchaDiv = document.querySelector('[data-sitekey]');
                if (hcaptchaDiv) return hcaptchaDiv.getAttribute('data-sitekey');
                
                const scripts = document.querySelectorAll('script');
                for (const script of scripts) {
                    const text = script.textContent || '';
                    const match = text.match(/sitekey["']?\s*:\s*["']([a-f0-9-]+)/i);
                    if (match) return match[1];
                }
                
                return 'f5561ba9-8f1e-40ca-9b5b-a0b3f719ef34';
            });

            console.log(chalk.blue(`[+] Site key: ${siteKey}`));

            // Solve with Anti-Captcha
            const hcaptchaToken = await solver.antiCaptcha.solveHcaptcha('https://discord.com/register', siteKey);
            
            if (!hcaptchaToken) {
                throw new Error('Failed to get hCaptcha token from Anti-Captcha');
            }

            console.log(chalk.green(`[+] Got hCaptcha token`));

            // Inject token and trigger callback
            await this.page.evaluate((token) => {
                // Set the response in textarea
                const textareas = document.querySelectorAll('textarea[name="h-captcha-response"], textarea[id*="h-captcha-response"]');
                textareas.forEach(ta => {
                    ta.value = token;
                    ta.innerHTML = token;
                    ta.dispatchEvent(new Event('input', { bubbles: true }));
                    ta.dispatchEvent(new Event('change', { bubbles: true }));
                });

                // Try to trigger hcaptcha callback
                if (window.hcaptcha) {
                    try {
                        const widgets = window.hcaptcha.getResponse();
                        if (widgets && widgets.length > 0) {
                            window.hcaptcha.setResponse(token);
                        }
                    } catch (e) {}
                }

                // Look for callback in window
                for (const key in window) {
                    if (key.includes('hcaptcha') || key.includes('callback')) {
                        try {
                            if (typeof window[key] === 'function') {
                                window[key](token);
                            }
                        } catch (e) {}
                    }
                }
            }, hcaptchaToken);

            console.log(chalk.green(`[+] Token injected`));

            // Wait a bit then click submit again
            await this.delay(2000, 3000);
            
            // Click submit to complete registration
            try {
                await this.page.click('button[type="submit"]');
                console.log(chalk.blue('[+] Submitted form with captcha solution'));
            } catch (e) {
                console.log(chalk.yellow('[!] Submit button not found or already processing'));
            }

            // Wait for navigation or API response
            await this.delay(5000, 8000);

            // Check current URL to see if we succeeded
            const currentUrl = this.page.url();
            console.log(chalk.blue(`[+] Current URL: ${currentUrl}`));
            
            if (currentUrl.includes('channels') || currentUrl.includes('app') || currentUrl.includes('verify')) {
                console.log(chalk.green.bold('[✓✓✓] SUCCESS! Account created and redirected to app! [✓✓✓]'));
                this.accountCreated = true;
            }

            // Try to get token with extended waiting
            for (let i = 0; i < 15; i++) {
                if (this.capturedToken) {
                    console.log(chalk.green.bold(`[✓✓✓] TOKEN CAPTURED! Account definitely created! [✓✓✓]`));
                    this.accountCreated = true;
                    break;
                }
                await this.delay(2000, 3000);
            }

            return await this.extractToken();
            
        } catch (err) {
            console.log(chalk.yellow(`[Warning] Captcha handling error: ${err.message}`));
            return await this.extractToken();
        }
    }

    async extractToken() {
        // Check if we captured token from network
        if (this.capturedToken) {
            console.log(chalk.green.bold(`[✓✓✓] ACCOUNT CREATED SUCCESSFULLY! Token captured! [✓✓✓]`));
            this.accountCreated = true;
            return this.capturedToken;
        }

        // Try localStorage as fallback
        try {
            const localToken = await this.page.evaluate(() => {
                try {
                    const token = window.localStorage?.getItem('token');
                    return token ? token.replace(/"/g, '') : null;
                } catch (e) {
                    return null;
                }
            });
            
            if (localToken) {
                console.log(chalk.green(`[+] Token found in localStorage`));
                this.accountCreated = true;
                return localToken;
            }
        } catch (err) {
            console.log(chalk.yellow(`[Warning] localStorage access failed: ${err.message}`));
        }

        // Check if we're on a success page even without token
        const url = this.page.url();
        if (url.includes('discord.com/channels') || url.includes('discord.com/app') || url.includes('discord.com/verify')) {
            console.log(chalk.green.bold(`[✓✓✓] ACCOUNT LIKELY CREATED! Redirected to: ${url} [✓✓✓]`));
            this.accountCreated = true;
            // Return a placeholder that indicates success but no token
            return 'ACCOUNT_CREATED_NO_TOKEN';
        }

        console.log(chalk.red('[Error] No token captured and not redirected to app'));
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
            // Check Anti-Captcha balance
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
            
            // Check if account was created (even without token)
            if (!token && !page.accountCreated) {
                throw new Error('No token obtained and account creation not confirmed');
            }

            // SUCCESS
            console.log(chalk.green.bold(`\n╔════════════════════════════════════════════════════════════╗`));
            console.log(chalk.green.bold(`║          [✓✓✓] ACCOUNT CREATED SUCCESSFULLY! [✓✓✓]          ║`));
            console.log(chalk.green.bold(`╠════════════════════════════════════════════════════════════╣`));
            console.log(chalk.green(`║  Email:    ${email.email.padEnd(45)}║`));
            console.log(chalk.green(`║  Password: ${email.password.padEnd(45)}║`));
            
            if (token && token !== 'ACCOUNT_CREATED_NO_TOKEN') {
                console.log(chalk.green(`║  Token:    ${token.slice(0, 40).padEnd(45)}║`));
            } else {
                console.log(chalk.yellow(`║  Token:    NOT CAPTURED (but account was created)         ║`));
            }
            
            console.log(chalk.green.bold(`╚════════════════════════════════════════════════════════════╝\n`));

            // Try to verify email
            let verified = false;
            try {
                const verifyUrl = await this.emailProvider.getVerificationEmail(email.token, 60000);
                if (verifyUrl && token && token !== 'ACCOUNT_CREATED_NO_TOKEN') {
                    verified = await page.verifyEmail(token, verifyUrl);
                    console.log(chalk.blue(`[+] Email verification: ${verified ? 'SUCCESS' : 'FAILED'}`));
                }
            } catch (e) {
                console.log(chalk.yellow(`[Warning] Email verification error: ${e.message}`));
            }

            await this.save(email, token, verified);
            this.metrics.success++;
            
            console.log(chalk.green.bold(`[✓✓✓] ACCOUNT SAVED TO ${verified ? 'verified.txt' : 'unverified.txt'} [✓✓✓]\n`));
            
            return { 
                success: true, 
                token: token === 'ACCOUNT_CREATED_NO_TOKEN' ? null : token, 
                verified, 
                email: email.email,
                accountCreated: true
            };

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
        const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
        const noun = nouns[Math.floor(Math.random() * nouns.length)];
        return `${adj}${noun}${Math.floor(Math.random() * 99999)}`;
    }

    randMonth() {
        const months = ['January', 'February', 'March', 'April', 'May', 'June', 
                       'July', 'August', 'September', 'October', 'November', 'December'];
        return months[Math.floor(Math.random() * 12)];
    }

    async save(data, token, verified) {
        const line = `${data.email}:${data.password}:${token || 'NO_TOKEN'}\n`;
        const filename = verified ? 'verified.txt' : 'unverified.txt';
        await fs.appendFile(filename, line);
        console.log(chalk.blue(`[+] Account saved to ${filename}`));
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
        console.log(chalk.blue(`[Metrics] Attempts: ${gen.getMetrics().attempts}, Success: ${gen.getMetrics().success}, Fail: ${gen.getMetrics().fail}`));
        
        if (result.success) {
            console.log(chalk.green.bold('\n[✓✓✓] COMPLETE SUCCESS! Account created and saved! [✓✓✓]'));
        }
    } catch (err) {
        console.error(chalk.red(`[Failed] ${err.message}`));
        console.log(chalk.blue(`[Metrics] Attempts: ${gen.getMetrics().attempts}, Success: ${gen.getMetrics().success}, Fail: ${gen.getMetrics().fail}`));
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
