const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const fs = require('fs').promises;
const chalk = require('chalk');
const { z } = require('zod');

puppeteer.use(StealthPlugin());

const CONFIG = {
    captcha: {
        antiCaptchaKey: process.env.ANTICAPTCHA_KEY || '373271de10fac6ff5aa75a2928acd339'
    }
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
        });

        if (createRes.data.errorId !== 0) {
            throw new Error(`AntiCaptcha error: ${createRes.data.errorDescription}`);
        }

        const taskId = createRes.data.taskId;
        console.log(chalk.blue(`[AntiCaptcha] Task created: ${taskId}`));

        // Poll for result
        for (let i = 0; i < 60; i++) {
            await new Promise(r => setTimeout(r, 5000));
            
            const result = await axios.post(`${this.baseUrl}/getTaskResult`, {
                clientKey: this.apiKey,
                taskId: taskId
            });

            console.log(chalk.blue(`[AntiCaptcha] Polling ${i + 1}/60: ${result.data.status}`));

            if (result.data.status === 'ready') {
                console.log(chalk.green(`[AntiCaptcha] Solution received!`));
                return result.data.solution.gRecaptchaResponse;
            }
        }
        throw new Error('AntiCaptcha timeout');
    }

    async getBalance() {
        const res = await axios.post(`${this.baseUrl}/getBalance`, {
            clientKey: this.apiKey
        });
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
        this.accountCreated = false;
        this.setupRequestInterception();
    }

    setupRequestInterception() {
        this.page.on('response', async (response) => {
            const request = response.request();
            const url = request.url();
            
            // Capture token from any API call
            if (url.includes('discord.com/api')) {
                const headers = request.headers();
                if (headers['authorization'] && headers['authorization'].startsWith('Bearer ')) {
                    this.capturedToken = headers['authorization'].replace('Bearer ', '');
                    console.log(chalk.cyan(`[+] Token captured!`));
                }
                
                // Check for register endpoint
                if (url.includes('/auth/register') || url.includes('/users')) {
                    const status = response.status();
                    console.log(chalk.blue(`[API Response] ${url} - Status: ${status}`));
                    
                    if (status === 200 || status === 201) {
                        this.accountCreated = true;
                        try {
                            const body = await response.json();
                            if (body.token) {
                                this.capturedToken = body.token;
                                console.log(chalk.green(`[+] Token from response body!`));
                            }
                        } catch (e) {}
                    }
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
            waitUntil: 'networkidle2', 
            timeout: 60000 
        });
        await this.delay(3000, 4000);
    }

    async fillForm(data) {
        console.log(chalk.blue('[+] Filling form...'));
        
        // Wait for form to be ready
        await this.page.waitForSelector('input[type="email"], form', { visible: true, timeout: 15000 });
        
        // Fill using evaluate for reliability
        await this.page.evaluate((formData) => {
            // Find all inputs
            const inputs = document.querySelectorAll('input');
            
            inputs.forEach(input => {
                const type = input.type || input.getAttribute('type');
                const placeholder = input.placeholder?.toLowerCase() || '';
                const name = input.name?.toLowerCase() || '';
                
                // Email
                if (type === 'email' || name.includes('email') || placeholder.includes('email')) {
                    input.focus();
                    input.value = formData.email;
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                }
                // Username
                else if (name.includes('username') || placeholder.includes('username')) {
                    input.focus();
                    input.value = formData.username;
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                }
                // Password
                else if (type === 'password' || name.includes('password') || placeholder.includes('password')) {
                    input.focus();
                    input.value = formData.password;
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                }
            });
        }, { email: data.email, username: data.username, password: data.password });

        // Handle DOB dropdowns
        await this.fillDOB(data.month, data.day, data.year);
        
        // Check ToS if exists
        await this.page.evaluate(() => {
            const checkboxes = document.querySelectorAll('input[type="checkbox"]');
            checkboxes.forEach(cb => {
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
        // Try to find and click dropdowns
        const dropdowns = await this.page.$$('[role="button"], div[class*="select"]');
        
        if (dropdowns.length >= 3) {
            // Month
            await dropdowns[0].click();
            await this.delay(500, 800);
            await this.selectDropdownValue(month);
            
            // Day
            await dropdowns[1].click();
            await this.delay(500, 800);
            await this.selectDropdownValue(day);
            
            // Year
            await dropdowns[2].click();
            await this.delay(500, 800);
            await this.selectDropdownValue(year);
        }
    }

    async selectDropdownValue(value) {
        await this.page.evaluate((val) => {
            // Try to find and click the option
            const options = document.querySelectorAll('[role="option"], div[class*="option"]');
            for (const opt of options) {
                if (opt.textContent.trim() === val) {
                    opt.click();
                    return true;
                }
            }
            // If not found by text, try scrolling
            const allDivs = document.querySelectorAll('div');
            for (const div of allDivs) {
                if (div.textContent.trim() === val && div.getAttribute('role') !== 'listbox') {
                    div.click();
                    return true;
                }
            }
            return false;
        }, value);
        await this.delay(500, 1000);
    }

    async submitAndSolveCaptcha(solver) {
        console.log(chalk.blue('[+] Submitting...'));
        
        // Click the submit button using JavaScript
        const clicked = await this.page.evaluate(() => {
            // Find submit button
            const buttons = Array.from(document.querySelectorAll('button'));
            const submitBtn = buttons.find(b => {
                const text = b.textContent.toLowerCase();
                return (text.includes('continue') || text.includes('register') || 
                        text.includes('sign up') || b.type === 'submit') && !b.disabled;
            });
            
            if (submitBtn) {
                submitBtn.click();
                submitBtn.dispatchEvent(new Event('click', { bubbles: true }));
                return true;
            }
            return false;
        });

        if (!clicked) {
            throw new Error('Could not find submit button');
        }

        await this.delay(3000, 5000);

        // Check for captcha
        console.log(chalk.blue('[+] Checking for captcha...'));
        
        const hasCaptcha = await this.page.evaluate(() => {
            return !!document.querySelector('iframe[src*="hcaptcha"]');
        });

        if (hasCaptcha) {
            console.log(chalk.yellow('[!] Captcha detected!'));
            
            const siteKey = await this.page.evaluate(() => {
                const el = document.querySelector('[data-sitekey]');
                return el ? el.getAttribute('data-sitekey') : 'f5561ba9-8f1e-40ca-9b5b-a0b3f719ef34';
            });

            const solution = await solver.solveHcaptcha('https://discord.com/register', siteKey);
            
            // Inject solution
            await this.page.evaluate((token) => {
                // Find hcaptcha response field
                const textareas = document.querySelectorAll('textarea');
                textareas.forEach(ta => {
                    if (ta.name.includes('h-captcha') || ta.id.includes('h-captcha')) {
                        ta.value = token;
                        ta.innerHTML = token;
                        ta.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                });
                
                // Trigger any callbacks
                if (window.hcaptcha) {
                    try {
                        window.hcaptcha.setResponse(token);
                    } catch(e) {}
                }
                
                // Look for data-callback
                const hcaptchaDiv = document.querySelector('[data-callback]');
                if (hcaptchaDiv) {
                    const callbackName = hcaptchaDiv.getAttribute('data-callback');
                    if (window[callbackName]) {
                        window[callbackName](token);
                    }
                }
            }, solution);

            console.log(chalk.green('[+] Captcha solution injected'));
            await this.delay(2000, 3000);

            // Click submit again
            await this.page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button'));
                const submitBtn = buttons.find(b => {
                    const text = b.textContent.toLowerCase();
                    return (text.includes('continue') || text.includes('register')) && !b.disabled;
                });
                if (submitBtn) submitBtn.click();
            });
        }

        // Wait for result
        console.log(chalk.blue('[+] Waiting for result...'));
        
        for (let i = 0; i < 30; i++) {
            await this.delay(2000, 3000);
            
            const url = this.page.url();
            console.log(chalk.blue(`[Check ${i+1}/30] URL: ${url}`));
            
            // Success indicators
            if (url.includes('/channels') || url.includes('/app') || url.includes('/verify')) {
                console.log(chalk.green.bold(`[✓✓✓] REDIRECTED TO APP! SUCCESS! [✓✓✓]`));
                this.accountCreated = true;
                break;
            }
            
            if (this.capturedToken) {
                console.log(chalk.green.bold(`[✓✓✓] TOKEN CAPTURED! SUCCESS! [✓✓✓]`));
                this.accountCreated = true;
                break;
            }

            // Check for error messages
            const errorMsg = await this.page.evaluate(() => {
                const errors = document.querySelectorAll('[class*="error"], [class*="message"]');
                for (const err of errors) {
                    const text = err.textContent;
                    if (text && !text.includes('available') && !text.includes('Nice')) {
                        return text;
                    }
                }
                return null;
            });

            if (errorMsg && errorMsg.includes('captcha')) {
                console.log(chalk.yellow(`[Captcha required]: ${errorMsg}`));
                // Try to solve again if needed
            } else if (errorMsg) {
                console.log(chalk.red(`[Error on page]: ${errorMsg}`));
            }
        }

        return await this.getToken();
    }

    async getToken() {
        if (this.capturedToken) {
            return this.capturedToken;
        }

        // Try localStorage
        try {
            const token = await this.page.evaluate(() => {
                return window.localStorage?.getItem('token')?.replace(/"/g, '');
            });
            if (token) {
                console.log(chalk.green(`[+] Token from localStorage`));
                return token;
            }
        } catch (e) {}

        // If account created but no token
        if (this.accountCreated) {
            return 'ACCOUNT_CREATED_NO_TOKEN';
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

            // SUCCESS
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

            // Verify email
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
        captchaSolver: new AntiCaptchaSolver(CONFIG.captcha.antiCaptchaKey)
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
