const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const fs = require('fs').promises;
const chalk = require('chalk');
const { z } = require('zod');

puppeteer.use(StealthPlugin());

const ConfigSchema = z.object({
    captcha: z.object({
        geminiKey: z.string(),
        groqKey: z.string()
    })
});

const CONFIG = ConfigSchema.parse({
    captcha: {
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

class CaptchaSolver {
    constructor() {
        this.kb = new Map();
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
        this.setupRequestInterception();
    }

    setupRequestInterception() {
        this.page.on('response', async (response) => {
            const request = response.request();
            const headers = request.headers();
            
            if (request.url().includes('discord.com/api') && headers['authorization']) {
                const auth = headers['authorization'];
                if (auth && auth.startsWith('Bearer ')) {
                    this.capturedToken = auth.replace('Bearer ', '');
                    console.log(chalk.cyan(`[+] Token captured from network request!`));
                }
            }
        });

        this.page.on('request', (request) => {
            const headers = request.headers();
            if (request.url().includes('discord.com/api') && headers['authorization']) {
                const auth = headers['authorization'];
                if (auth && auth.startsWith('Bearer ')) {
                    this.capturedToken = auth.replace('Bearer ', '');
                }
            }
        });
    }

    static async create(config) {
        const browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });
        const page = await browser.newPage();
        await page.setViewport({ width: 1366, height: 768 });
        return new DiscordRegisterPage(browser, page);
    }

    async navigate() {
        await this.page.goto('https://discord.com/register', { waitUntil: 'networkidle2', timeout: 60000 });
    }

    async fillForm(data) {
        await this.type('input[name="email"]', data.email);
        await this.type('input[name="username"]', data.username);
        await this.type('input[name="password"]', data.password);

        await this.selectDropdown('Month', data.month);
        await this.selectDropdown('Day', data.day);
        await this.selectDropdown('Year', data.year);

        await this.page.evaluate(() => {
            document.querySelectorAll('input[type="checkbox"]').forEach(cb => { if (!cb.checked) cb.click(); });
        });

        await this.delay(1000, 2000);
    }

    async submit() {
        await this.page.click('button[type="submit"]');
        await this.delay(2000, 4000);
    }

    async type(selector, value) {
        await this.page.waitForSelector(selector);
        await this.page.click(selector);
        for (const c of value) {
            await this.page.keyboard.type(c, { delay: Math.floor(Math.random() * 100 + 50) });
        }
        await this.delay(300, 800);
    }

    async selectDropdown(label, value) {
        await this.page.click(`div[role="button"][aria-label*="${label}"]`);
        await this.delay(500, 1000);
        await this.page.evaluate((val) => {
            document.querySelectorAll('div[role="option"]').forEach(opt => {
                if (opt.textContent.trim() === val) opt.click();
            });
        }, value);
        await this.delay(500, 1000);
    }

    async solveCaptcha(solver) {
        try {
            console.log(chalk.blue('[+] Checking for captcha...'));
            await this.delay(3000, 5000);
            
            // Check if hcaptcha iframe exists
            const iframeHandle = await this.page.$('iframe[src*="hcaptcha"]');
            
            if (!iframeHandle) {
                console.log(chalk.green('[+] No captcha iframe found, proceeding...'));
                await this.delay(3000, 5000);
                return this.getToken();
            }

            console.log(chalk.yellow('[!] Captcha iframe detected, attempting to solve...'));

            // Try to get the frame content - this might fail due to cross-origin [^46^][^47^]
            let frame;
            try {
                frame = await iframeHandle.contentFrame();
            } catch (e) {
                console.log(chalk.yellow('[!] Cannot access iframe content directly (cross-origin)'));
            }

            if (frame) {
                console.log(chalk.blue('[+] Successfully accessed iframe content'));
                
                // Try to find and click the checkbox with multiple selectors
                const checkboxSelectors = [
                    '.checkbox',
                    '#checkbox',
                    '.h-captcha-checkbox',
                    '[role="checkbox"]',
                    '.checkbox-container',
                    '#anchor-checkbox',
                    'input[type="checkbox"]'
                ];
                
                let clicked = false;
                for (const selector of checkboxSelectors) {
                    try {
                        await frame.waitForSelector(selector, { timeout: 3000 });
                        await frame.click(selector);
                        console.log(chalk.green(`[+] Clicked checkbox with selector: ${selector}`));
                        clicked = true;
                        break;
                    } catch (e) {
                        continue;
                    }
                }

                if (!clicked) {
                    console.log(chalk.yellow('[!] Could not find checkbox with standard selectors'));
                }

                await this.delay(3000, 5000);

                // Check if accessibility challenge appeared
                const hasChallenge = await frame.$('input[name="captcha"]') !== null;
                
                if (hasChallenge) {
                    console.log(chalk.yellow('[!] Accessibility challenge detected, solving...'));
                    
                    await frame.waitForSelector('input[name="captcha"]', { timeout: 10000 });

                    for (let i = 0; i < 20; i++) {
                        const qel = await frame.$('[id^="prompt-text"]');
                        if (!qel) break;
                        
                        const q = await qel.evaluate(el => el.textContent);
                        console.log(chalk.blue(`[Question ${i+1}] ${q}`));
                        
                        const a = await solver.solve(q);
                        console.log(chalk.cyan(`[Answer] ${a}`));
                        
                        await frame.type('input[name="captcha"]', a);
                        await frame.click('.button-submit');
                        await this.delay(1500, 2500);
                        
                        const stillThere = await frame.$('input[name="captcha"]') !== null;
                        if (!stillThere) {
                            console.log(chalk.green('[+] Challenge completed!'));
                            break;
                        }
                    }
                }
            } else {
                // Fallback: Try using JavaScript injection to click the checkbox [^52^]
                console.log(chalk.blue('[+] Trying JavaScript injection method...'));
                try {
                    await this.page.evaluate(() => {
                        // Try to find the checkbox inside the iframe using contentDocument
                        const iframe = document.querySelector('iframe[src*="hcaptcha"]');
                        if (iframe && iframe.contentDocument) {
                            const checkbox = iframe.contentDocument.querySelector('.checkbox, #checkbox, [role="checkbox"]');
                            if (checkbox) {
                                checkbox.click();
                                return true;
                            }
                        }
                        return false;
                    });
                    console.log(chalk.green('[+] JavaScript injection click attempted'));
                } catch (e) {
                    console.log(chalk.red(`[Error] JavaScript injection failed: ${e.message}`));
                }
            }

            // Wait for token to be captured
            await this.delay(5000, 8000);
            return this.getToken();
            
        } catch (err) {
            console.log(chalk.yellow(`[Warning] Captcha handling error: ${err.message}`));
            return this.getToken();
        }
    }

    async getToken() {
        if (this.capturedToken) {
            console.log(chalk.green(`[+] Using network-captured token`));
            return this.capturedToken;
        }

        // Fallback: try localStorage
        try {
            const t = await this.page.evaluate(() => {
                try {
                    return window.localStorage ? window.localStorage.getItem('token') : null;
                } catch (e) {
                    return null;
                }
            });
            if (t) {
                console.log(chalk.green(`[+] Using localStorage token`));
                return t.replace(/"/g, '');
            }
        } catch (err) {
            console.log(chalk.yellow(`[Warning] localStorage access failed: ${err.message}`));
        }

        console.log(chalk.red('[Error] No token captured from network or localStorage'));
        return null;
    }

    async verifyEmail(token, verifyUrl) {
        const urlToken = new URL(verifyUrl).searchParams.get('token');
        if (!urlToken) return false;
        const res = await axios.post(
            'https://discord.com/api/v9/auth/verify',
            { token: urlToken },
            { headers: { Authorization: token } }
        );
        return res.status === 200 || res.status === 204;
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
            
            if (!token) throw new Error('No token obtained');

            // SUCCESS - Account created!
            console.log(chalk.green.bold(`[✓] ACCOUNT CREATED SUCCESSFULLY!`));
            console.log(chalk.green(`[✓] Email: ${email.email}`));
            console.log(chalk.green(`[✓] Password: ${email.password}`));
            console.log(chalk.green(`[✓] Token: ${token.slice(0, 30)}...`));

            const verifyUrl = await this.emailProvider.getVerificationEmail(email.token);
            const verified = verifyUrl ? await page.verifyEmail(token, verifyUrl) : false;

            await this.save(email, token, verified);
            this.metrics.success++;
            
            console.log(chalk.green.bold(`[✓] ${verified ? 'VERIFIED' : 'UNVERIFIED'} account saved!`));
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
        const a = ['Shadow', 'Silent', 'Dark', 'Ghost', 'Cyber'][Math.floor(Math.random() * 5)];
        const n = ['Hunter', 'Wraith', 'Ninja', 'Coder'][Math.floor(Math.random() * 4)];
        return `${a}${n}${Math.floor(Math.random() * 99999)}`;
    }

    randMonth() {
        return ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][Math.floor(Math.random() * 12)];
    }

    async save(data, token, verified) {
        const line = `${data.email}:${data.password}:${token}\n`;
        await fs.appendFile(verified ? 'verified.txt' : 'unverified.txt', line);
        console.log(chalk.blue(`[+] Account saved to ${verified ? 'verified.txt' : 'unverified.txt'}`));
    }

    getMetrics() {
        return { ...this.metrics };
    }
}

async function main() {
    console.log(chalk.green.bold('[+] Starting Discord Account Generator...'));
    
    const gen = new AccountGenerator({
        emailProvider: new MailTmProvider(),
        captchaSolver: new CaptchaSolver()
    });

    try {
        const result = await gen.generate();
        console.log(chalk.blue(`[Metrics] ${JSON.stringify(gen.getMetrics())}`));
        
        if (result.success) {
            console.log(chalk.green.bold('\n[✓✓✓] SUCCESS! Account created and saved!'));
        }
    } catch (err) {
        console.error(chalk.red(`[Failed] ${err.message}`));
        console.log(chalk.blue(`[Metrics] ${JSON.stringify(gen.getMetrics())}`));
    }
    
    console.log(chalk.green('[+] Done'));
    process.exit(0);
}

// Prevent multiple runs
if (require.main === module) {
    main().catch(err => {
        console.error(chalk.red(err));
        process.exit(1);
    });
}
