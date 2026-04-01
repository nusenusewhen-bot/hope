const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const chalk = require('chalk');

puppeteer.use(StealthPlugin());

const CONFIG = {
    discord: {
        registerUrl: 'https://discord.com/register',
        apiBase: 'https://discord.com/api/v9'
    },
    captcha: {
        geminiKey: process.env.GEMINI_KEY || 'AIzaSyDD5n4NAr4J2FZGjmKswLFFBkT9XSD9GKc',
        groqKey: process.env.GROQ_KEY || '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'
    },
    delays: {
        typing: { min: 50, max: 200 },
        action: { min: 500, max: 1500 },
        submit: { min: 2000, max: 4000 }
    }
};

try {
    var { proxies } = require('./proxies.js');
} catch (e) {
    var proxies = [];
}

class FreeEmailProvider {
    constructor() {
        this.baseUrl = 'https://api.mail.tm';
        this.token = null;
        this.email = null;
        this.password = this.generatePassword();
    }

    generatePassword() {
        const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
        let pass = '';
        for (let i = 0; i < 12; i++) {
            pass += chars[Math.floor(Math.random() * chars.length)];
        }
        return pass;
    }

    async createAccount() {
        try {
            const domainRes = await axios.get(`${this.baseUrl}/domains`);
            const domain = domainRes.data['hydra:member'][0].domain;

            const username = `user${Date.now()}${Math.floor(Math.random() * 1000)}`;
            const email = `${username}@${domain}`;

            await axios.post(`${this.baseUrl}/accounts`, {
                address: email,
                password: this.password
            });

            const loginRes = await axios.post(`${this.baseUrl}/token`, {
                address: email,
                password: this.password
            });

            this.token = loginRes.data.token;
            this.email = email;

            console.log(chalk.green(`[+] Created email: ${email}`));
            return { email, password: this.password, token: this.token };
        } catch (err) {
            console.log(chalk.red(`[Email Create Error] ${err.message}`));
            return null;
        }
    }

    async getVerificationEmail(timeout = 120000) {
        const startTime = Date.now();
        while (Date.now() - startTime < timeout) {
            try {
                const response = await axios.get(`${this.baseUrl}/messages`, {
                    headers: { Authorization: `Bearer ${this.token}` }
                });

                for (const msg of response.data['hydra:member']) {
                    const detail = await axios.get(`${this.baseUrl}/messages/${msg.id}`, {
                        headers: { Authorization: `Bearer ${this.token}` }
                    });
                    
                    const from = detail.data.from.address.toLowerCase();
                    const subject = detail.data.subject.toLowerCase();
                    
                    if (from.includes('discord') && (subject.includes('verify') || subject.includes('confirm'))) {
                        const verifyUrl = this.extractVerifyUrl(detail.data.text || detail.data.html);
                        if (verifyUrl) return verifyUrl;
                    }
                }
            } catch (err) {
                console.log(chalk.yellow(`[Email Check] ${err.message}`));
            }
            await new Promise(r => setTimeout(r, 5000));
        }
        return null;
    }

    extractVerifyUrl(content) {
        const match = content.match(/https:\/\/discord\.com\/verify\?token=[^"'\s]+/) 
            || content.match(/https:\/\/click\.discord\.com\/ls\/click\?[^"'\s]+/);
        return match ? match[0] : null;
    }
}

class ProxyRotator {
    constructor(proxyList) {
        this.proxies = proxyList || [];
        this.currentIndex = 0;
    }

    getNextProxy() {
        if (this.proxies.length === 0) return null;
        const proxy = this.proxies[this.currentIndex % this.proxies.length];
        this.currentIndex++;
        return this.parseProxy(proxy);
    }

    parseProxy(proxyString) {
        if (typeof proxyString === 'object') return proxyString;
        const parts = proxyString.split(':');
        if (parts.length === 2) {
            return { host: parts[0], port: parts[1], url: `http://${parts[0]}:${parts[1]}` };
        } else if (parts.length >= 4) {
            return {
                host: parts[0],
                port: parts[1],
                username: parts[2],
                password: parts[3],
                url: `http://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`
            };
        }
        return null;
    }
}

class CaptchaSolver {
    constructor(config) {
        this.config = config;
        this.knowledgeBase = new Map();
    }

    async solveWithAI(question) {
        const lowerQ = question.toLowerCase().trim();
        if (this.knowledgeBase.has(lowerQ)) return this.knowledgeBase.get(lowerQ);
        
        const [geminiResult, groqResult] = await Promise.all([
            this.callGemini(question),
            this.callGroq(question)
        ]);
        
        const answer = geminiResult || groqResult || 'nee';
        this.knowledgeBase.set(lowerQ, answer);
        return answer;
    }

    async callGemini(question) {
        try {
            const response = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${this.config.geminiKey}`,
                {
                    contents: [{ parts: [{ text: `Dutch yes/no CAPTCHA. Answer ONLY 'ja' or 'nee'. Question: ${question}` }] }],
                    generationConfig: { temperature: 0, maxOutputTokens: 5 }
                },
                { timeout: 8000 }
            );
            const text = response.data.candidates[0].content.parts[0].text.toLowerCase();
            if (text.includes('ja') && !text.includes('nee')) return 'ja';
            if (text.includes('nee')) return 'nee';
            return null;
        } catch { return null; }
    }

    async callGroq(question) {
        try {
            const response = await axios.post(
                'https://api.groq.com/openai/v1/chat/completions',
                {
                    model: 'llama-3.3-70b-versatile',
                    messages: [{ role: 'user', content: `Dutch yes/no CAPTCHA. Answer ONLY 'ja' or 'nee'. Question: ${question}` }],
                    temperature: 0, max_tokens: 5
                },
                { headers: { Authorization: `Bearer ${this.config.groqKey}` }, timeout: 8000 }
            );
            const text = response.data.choices[0].message.content.toLowerCase();
            if (text.includes('ja') && !text.includes('nee')) return 'ja';
            if (text.includes('nee')) return 'nee';
            return null;
        } catch { return null; }
    }
}

class DiscordGenerator {
    constructor(config) {
        this.config = config;
        this.proxyRotator = new ProxyRotator(proxies);
        this.emailProvider = new FreeEmailProvider();
        this.captchaSolver = new CaptchaSolver(config.captcha);
    }

    generateUsername() {
        const adj = ['Shadow', 'Silent', 'Hidden', 'Dark', 'Ghost', 'Cyber'][Math.floor(Math.random() * 6)];
        const noun = ['Hunter', 'Walker', 'Wraith', 'Specter', 'Ninja'][Math.floor(Math.random() * 5)];
        return `${adj}${noun}${Math.floor(Math.random() * 99999)}`;
    }

    generateBirthday() {
        const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
        return {
            day: Math.floor(Math.random() * 28) + 1,
            month: months[Math.floor(Math.random() * 12)],
            year: Math.floor(Math.random() * (2004 - 1990) + 1990)
        };
    }

    async humanLikeDelay(type = 'typing') {
        const range = this.config.delays[type] || this.config.delays.typing;
        await new Promise(r => setTimeout(r, Math.floor(Math.random() * (range.max - range.min) + range.min)));
    }

    async createAccount() {
        const proxy = this.proxyRotator.getNextProxy();
        const emailData = await this.emailProvider.createAccount();
        
        if (!emailData) {
            console.log(chalk.red('[!] Failed to create email'));
            return null;
        }

        console.log(chalk.cyan(`[+] Using: ${emailData.email}`));

        const browserOptions = {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process',
                '--disable-gpu',
                '--window-size=1366,768'
            ]
        };

        if (proxy) browserOptions.args.push(`--proxy-server=${proxy.host}:${proxy.port}`);

        const browser = await puppeteer.launch(browserOptions);
        const page = await browser.newPage();

        try {
            await page.setViewport({ width: 1366, height: 768 });
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');

            await page.goto(this.config.discord.registerUrl, { waitUntil: 'networkidle2', timeout: 60000 });

            const username = this.generateUsername();
            const birthday = this.generateBirthday();

            await this.fillField(page, 'input[name="email"]', emailData.email);
            await this.fillField(page, 'input[name="username"]', username);
            await this.fillField(page, 'input[name="password"]', emailData.password);

            await this.setDropdown(page, 'Month', birthday.month);
            await this.setDropdown(page, 'Day', birthday.day.toString());
            await this.setDropdown(page, 'Year', birthday.year.toString());

            await page.evaluate(() => {
                const checkboxes = document.querySelectorAll('input[type="checkbox"]');
                checkboxes.forEach(cb => { if (!cb.checked) cb.click(); });
            });

            await this.humanLikeDelay('submit');
            await page.click('button[type="submit"]');

            const token = await this.handleCaptcha(page);
            if (!token) {
                console.log(chalk.red('[!] Failed to get token'));
                await browser.close();
                return null;
            }

            console.log(chalk.green(`[+] Token: ${token.substring(0, 20)}...`));

            const verifyUrl = await this.emailProvider.getVerificationEmail();
            const verified = verifyUrl ? await this.verifyEmail(token, verifyUrl) : false;

            await this.saveToken(emailData, token, verified);
            console.log(verified ? chalk.green('[+] Verified') : chalk.yellow('[+] Unverified'));

            await browser.close();
            return token;

        } catch (err) {
            console.log(chalk.red(`[Error] ${err.message}`));
            await browser.close();
            return null;
        }
    }

    async fillField(page, selector, value) {
        await page.waitForSelector(selector, { timeout: 10000 });
        await page.click(selector);
        for (const char of value) {
            await page.keyboard.type(char, { delay: Math.floor(Math.random() * 150 + 50) });
        }
        await this.humanLikeDelay('action');
    }

    async setDropdown(page, label, value) {
        const selector = `div[role="button"][aria-label*="${label}"]`;
        await page.waitForSelector(selector, { timeout: 10000 });
        await page.click(selector);
        await this.humanLikeDelay('action');
        
        const option = await page.waitForSelector(`div[role="option"]:has-text("${value}")`, { timeout: 5000 });
        await option.click();
        await this.humanLikeDelay('action');
    }

    async handleCaptcha(page) {
        try {
            await page.waitForSelector('iframe[src*="hcaptcha"]', { timeout: 30000 });
            const frames = await page.frames();
            const captchaFrame = frames.find(f => f.url().includes('hcaptcha'));
            
            if (!captchaFrame) {
                console.log(chalk.yellow('[!] No captcha frame found, checking token...'));
                return await this.extractToken(page);
            }

            console.log(chalk.yellow('[!] Solving captcha...'));

            await captchaFrame.waitForSelector('#checkbox', { timeout: 10000 });
            await captchaFrame.click('#checkbox');
            
            await new Promise(r => setTimeout(r, 2000));

            const menuBtn = await captchaFrame.$('#menu-info');
            if (menuBtn) {
                await menuBtn.click();
                await new Promise(r => setTimeout(r, 1000));

                const items = await captchaFrame.$$('[role="menuitem"]');
                for (const item of items) {
                    const text = await item.evaluate(el => el.textContent);
                    if (text && (text.includes('Accessibility') || text.includes('Toegankelijkheidja' or 'nee'. Question: ${question}` }] }],
                    generationConfig: { temperature: 0, maxOutputTokens: 5 }
                },
                { timeout: 8000 }
            );
            const text = response.data.candidates[0].content.parts[0].text.toLowerCase();
            if (text.includes('ja') && !text.includes('nee')) return 'ja';
            if (text.includes('nee')) return 'nee';
            return null;
        } catch { return null; }
    }

    async callGroq(question) {
        try {
            const response = await axios.post(
                'https://api.groq.com/openai/v1/chat/completions',
                {
                    model: 'llama-3.3-70b-versatile',
                    messages: [{ role: 'user', content: `Dutch yes/no CAPTCHA. Answer ONLY 'ja' or 'nee'. Question: ${question}` }],
                    temperature: 0, max_tokens: 5
                },
                { headers: { Authorization: `Bearer ${this.config.groqKey}` }, timeout: 8000 }
            );
            const text = response.data.choices[0].message.content.toLowerCase();
            if (text.includes('ja') && !text.includes('nee')) return 'ja';
            if (text.includes('nee')) return 'nee';
            return null;
        } catch { return null; }
    }
}

class DiscordGenerator {
    constructor(config) {
        this.config = config;
        this.proxyRotator = new ProxyRotator(proxies);
        this.emailProvider = new FreeEmailProvider();
        this.captchaSolver = new CaptchaSolver(config.captcha);
    }

    generateUsername() {
        const adj = ['Shadow', 'Silent', 'Hidden', 'Dark', 'Ghost', 'Cyber'][Math.floor(Math.random() * 6)];
        const noun = ['Hunter', 'Walker', 'Wraith', 'Specter', 'Ninja'][Math.floor(Math.random() * 5)];
        return `${adj}${noun}${Math.floor(Math.random() * 99999)}`;
    }

    generateBirthday() {
        const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
        return {
            day: Math.floor(Math.random() * 28) + 1,
            month: months[Math.floor(Math.random() * 12)],
            year: Math.floor(Math.random() * (2004 - 1990) + 1990)
        };
    }

    async humanLikeDelay(type = 'typing') {
        const range = this.config.delays[type] || this.config.delays.typing;
        await new Promise(r => setTimeout(r, Math.floor(Math.random() * (range.max - range.min) + range.min)));
    }

    async createAccount() {
        const proxy = this.proxyRotator.getNextProxy();
        const emailData = await this.emailProvider.createAccount();
        
        if (!emailData) {
            console.log(chalk.red('[!] Failed to create email'));
            return null;
        }

        console.log(chalk.cyan(`[+] Using: ${emailData.email}`));

        const browserOptions = {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process',
                '--disable-gpu',
                '--window-size=1366,768'
            ]
        };

        if (proxy) browserOptions.args.push(`--proxy-server=${proxy.host}:${proxy.port}`);

        const browser = await puppeteer.launch(browserOptions);
        const page = await browser.newPage();

        try {
            await page.setViewport({ width: 1366, height: 768 });
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');

            await page.goto(this.config.discord.registerUrl, { waitUntil: 'networkidle2', timeout: 60000 });

            const username = this.generateUsername();
            const birthday = this.generateBirthday();

            await this.fillField(page, 'input[name="email"]', emailData.email);
            await this.fillField(page, 'input[name="username"]', username);
            await this.fillField(page, 'input[name="password"]', emailData.password);

            await this.setDropdown(page, 'Month', birthday.month);
            await this.setDropdown(page, 'Day', birthday.day.toString());
            await this.setDropdown(page, 'Year', birthday.year.toString());

            await page.evaluate(() => {
                const checkboxes = document.querySelectorAll('input[type="checkbox"]');
                checkboxes.forEach(cb => { if (!cb.checked) cb.click(); });
            });

            await this.humanLikeDelay('submit');
            await page.click('button[type="submit"]');

            const token = await this.handleCaptcha(page);
            if (!token) {
                console.log(chalk.red('[!] Failed to get token'));
                await browser.close();
                return null;
            }

            console.log(chalk.green(`[+] Token: ${token.substring(0, 20)}...`));

            const verifyUrl = await this.emailProvider.getVerificationEmail();
            const verified = verifyUrl ? await this.verifyEmail(token, verifyUrl) : false;

            await this.saveToken(emailData, token, verified);
            console.log(verified ? chalk.green('[+] Verified') : chalk.yellow('[+] Unverified'));

            await browser.close();
            return token;

        } catch (err) {
            console.log(chalk.red(`[Error] ${err.message}`));
            await browser.close();
            return null;
        }
    }

    async fillField(page, selector, value) {
        await page.waitForSelector(selector, { timeout: 10000 });
        await page.click(selector);
        for (const char of value) {
            await page.keyboard.type(char, { delay: Math.floor(Math.random() * 150 + 50) });
        }
        await this.humanLikeDelay('action');
    }

    async setDropdown(page, label, value) {
        const selector = `div[role="button"][aria-label*="${label}"]`;
        await page.waitForSelector(selector, { timeout: 10000 });
        await page.click(selector);
        await this.humanLikeDelay('action');
        
        const option = await page.waitForSelector(`div[role="option"]:has-text("${value}")`, { timeout: 5000 });
        await option.click();
        await this.humanLikeDelay('action');
    }

    async handleCaptcha(page) {
        try {
            await page.waitForSelector('iframe[src*="hcaptcha"]', { timeout: 30000 });
            const frames = await page.frames();
            const captchaFrame = frames.find(f => f.url().includes('hcaptcha'));
            
            if (!captchaFrame) {
                console.log(chalk.yellow('[!] No captcha frame found, checking token...'));
                return await this.extractToken(page);
            }

            console.log(chalk.yellow('[!] Solving captcha...'));

            await captchaFrame.waitForSelector('#checkbox', { timeout: 10000 });
            await captchaFrame.click('#checkbox');
            
            await new Promise(r => setTimeout(r, 2000));

            const menuBtn = await captchaFrame.$('#menu-info');
            if (menuBtn) {
                await menuBtn.click();
                await new Promise(r => setTimeout(r, 1000));

                const items = await captchaFrame.$$('[role="menuitem"]');
                for (const item of items) {
                    const text = await item.evaluate(el => el.textContent);
                    if (text && (text.includes('Accessibility') || text.includes('Toegankelijkheid'))) {
                        await item.click();
                        break;
                    }
                }
            }

            await captchaFrame.waitForSelector('input[name="captcha"]', { timeout: 10000 });

            for (let i = 0; i < 20; i++) {
                const questionEl = await captchaFrame.$('[id^="prompt-text"]');
                if (!questionEl) {
                    console.log(chalk.green('[+] Captcha solved!'));
                    break;
                }
                
                const question = await questionEl.evaluate(el => el.textContent);
                console.log(chalk.cyan(`[Q] ${question}`));
                
                const answer = await this.captchaSolver.solveWithAI(question);
                console.log(chalk.cyan(`[A] ${answer}`));
                
                const input = await captchaFrame.$('input[name="captcha"]');
                await input.click();
                await input.type(answer);
                
                const submit = await captchaFrame.$('.button-submit');
                if (submit) await submit.click();
                
                await new Promise(r => setTimeout(r, 2000));
            }

            return await this.extractToken(page);
        } catch (err) {
            console.log(chalk.yellow(`[Captcha Error] ${err.message}`));
            return await this.extractToken(page);
        }
    }

    async extractToken(page) {
        try {
            const token = await page.evaluate(() => localStorage.getItem('token'));
            return token ? token.replace(/"/g, '') : null;
        } catch { return null; }
    }

    async verifyEmail(token, verifyUrl) {
        try {
            const urlToken = new URL(verifyUrl).searchParams.get('token');
            if (!urlToken) return false;
            
            const response = await axios.post(
                `${this.config.discord.apiBase}/auth/verify`,
                { token: urlToken },
                { headers: { Authorization: token, 'Content-Type': 'application/json' } }
            );
            
            return response.status === 200 || response.status === 204;
        } catch { return false; }
    }

    async saveToken(emailData, token, verified) {
        const filename = verified ? 'verified.txt' : 'unverified.txt';
        const data = `${emailData.email}:${emailData.password}:${token}\n`;
        await fs.appendFile(path.join(__dirname, filename), data);
    }
}

async function main() {
    console.log(chalk.green('[+] Starting...'));
    const generator = new DiscordGenerator(CONFIG);
    await generator.createAccount();
    console.log(chalk.green('[+] Done'));
    process.exit(0);
}

main().catch(err => {
    console.error(chalk.red(err));
    process.exit(1);
});
