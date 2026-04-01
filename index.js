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
        geminiKey: process.env.GEMINI_KEY || '',
        groqKey: process.env.GROQ_KEY || ''
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
            console.log(chalk.green(`[+] Email: ${email}`));
            return { email, password: this.password, token: this.token };
        } catch (err) {
            console.log(chalk.red(`[Email Error] ${err.message}`));
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
                        const content = detail.data.text || detail.data.html;
                        const match = content.match(/https:\/\/discord\.com\/verify\?token=[^"'\s]+/);
                        if (match) return match[0];
                    }
                }
            } catch (err) {
                console.log(chalk.yellow(`[Check] ${err.message}`));
            }
            await new Promise(r => setTimeout(r, 5000));
        }
        return null;
    }
}

class CaptchaSolver {
    constructor(config) {
        this.config = config;
        this.kb = new Map();
    }

    async solve(question) {
        const q = question.toLowerCase().trim();
        if (this.kb.has(q)) return this.kb.get(q);
        
        const answer = (await this.callGemini(q)) || (await this.callGroq(q)) || 'nee';
        this.kb.set(q, answer);
        return answer;
    }

    async callGemini(q) {
        try {
            const res = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${this.config.geminiKey}`,
                {
                    contents: [{ parts: [{ text: `Dutch yes/no CAPTCHA. Answer ONLY 'ja' or 'nee'. Question: ${q}` }] }],
                    generationConfig: { temperature: 0, maxOutputTokens: 5 }
                },
                { timeout: 8000 }
            );
            const t = res.data.candidates[0].content.parts[0].text.toLowerCase();
            if (t.includes('ja') && !t.includes('nee')) return 'ja';
            if (t.includes('nee')) return 'nee';
            return null;
        } catch { return null; }
    }

    async callGroq(q) {
        try {
            const res = await axios.post(
                'https://api.groq.com/openai/v1/chat/completions',
                {
                    model: 'llama-3.3-70b-versatile',
                    messages: [{ role: 'user', content: `Dutch yes/no CAPTCHA. Answer ONLY 'ja' or 'nee'. Question: ${q}` }],
                    temperature: 0, max_tokens: 5
                },
                { headers: { Authorization: `Bearer ${this.config.groqKey}` }, timeout: 8000 }
            );
            const t = res.data.choices[0].message.content.toLowerCase();
            if (t.includes('ja') && !t.includes('nee')) return 'ja';
            if (t.includes('nee')) return 'nee';
            return null;
        } catch { return null; }
    }
}

class Generator {
    constructor() {
        this.proxyRotator = { getNextProxy: () => null };
        this.email = new FreeEmailProvider();
        this.solver = new CaptchaSolver(CONFIG.captcha);
    }

    genUser() {
        const a = ['Shadow', 'Silent', 'Dark', 'Ghost', 'Cyber'][Math.floor(Math.random() * 5)];
        const n = ['Hunter', 'Wraith', 'Ninja', 'Coder'][Math.floor(Math.random() * 4)];
        return `${a}${n}${Math.floor(Math.random() * 99999)}`;
    }

    genBday() {
        const m = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
        return {
            day: Math.floor(Math.random() * 28) + 1,
            month: m[Math.floor(Math.random() * 12)],
            year: Math.floor(Math.random() * (2004 - 1990) + 1990)
        };
    }

    async delay(min, max) {
        await new Promise(r => setTimeout(r, Math.floor(Math.random() * (max - min) + min)));
    }

    async create() {
        const emailData = await this.email.createAccount();
        if (!emailData) return null;

        const browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });

        const page = await browser.newPage();
        await page.setViewport({ width: 1366, height: 768 });

        try {
            await page.goto(CONFIG.discord.registerUrl, { waitUntil: 'networkidle2', timeout: 60000 });

            const user = this.genUser();
            const bday = this.genBday();

            await this.type(page, 'input[name="email"]', emailData.email);
            await this.type(page, 'input[name="username"]', user);
            await this.type(page, 'input[name="password"]', emailData.password);

            await this.dropdown(page, 'Month', bday.month);
            await this.dropdown(page, 'Day', bday.day.toString());
            await this.dropdown(page, 'Year', bday.year.toString());

            await page.evaluate(() => {
                document.querySelectorAll('input[type="checkbox"]').forEach(cb => { if (!cb.checked) cb.click(); });
            });

            await this.delay(2000, 4000);
            await page.click('button[type="submit"]');

            const token = await this.solveCaptcha(page);
            if (!token) {
                await browser.close();
                return null;
            }

            console.log(chalk.green(`[+] Token: ${token.slice(0, 20)}...`));

            const verifyUrl = await this.email.getVerificationEmail();
            const verified = verifyUrl ? await this.verify(token, verifyUrl) : false;

            await this.save(emailData, token, verified);
            await browser.close();
            return token;

        } catch (err) {
            console.log(chalk.red(`[Error] ${err.message}`));
            await browser.close();
            return null;
        }
    }

    async type(page, sel, val) {
        await page.waitForSelector(sel);
        await page.click(sel);
        for (const c of val) {
            await page.keyboard.type(c, { delay: Math.floor(Math.random() * 150 + 50) });
        }
        await this.delay(500, 1500);
    }

    async dropdown(page, label, val) {
        await page.click(`div[role="button"][aria-label*="${label}"]`);
        await this.delay(500, 1000);
        await page.click(`div[role="option"]:has-text("${val}")`);
        await this.delay(500, 1000);
    }

    async solveCaptcha(page) {
        try {
            await page.waitForSelector('iframe[src*="hcaptcha"]', { timeout: 30000 });
            const frames = await page.frames();
            const frame = frames.find(f => f.url().includes('hcaptcha'));
            if (!frame) return await this.getToken(page);

            await frame.click('#checkbox');
            await new Promise(r => setTimeout(r, 2000));

            const menu = await frame.$('#menu-info');
            if (menu) {
                await menu.click();
                await new Promise(r => setTimeout(r, 1000));
                const items = await frame.$$('[role="menuitem"]');
                for (const item of items) {
                    const text = await item.evaluate(el => el.textContent);
                    if (text && (text.includes('Accessibility') || text.includes('Toegankelijkheid'))) {
                        await item.click();
                        break;
                    }
                }
            }

            await frame.waitForSelector('input[name="captcha"]', { timeout: 10000 });

            for (let i = 0; i < 20; i++) {
                const qel = await frame.$('[id^="prompt-text"]');
                if (!qel) break;
                
                const q = await qel.evaluate(el => el.textContent);
                const a = await this.solver.solve(q);
                
                await frame.type('input[name="captcha"]', a);
                await frame.click('.button-submit');
                await new Promise(r => setTimeout(r, 2000));
            }

            return await this.getToken(page);
        } catch (err) {
            return await this.getToken(page);
        }
    }

    async getToken(page) {
        try {
            const t = await page.evaluate(() => localStorage.getItem('token'));
            return t ? t.replace(/"/g, '') : null;
        } catch { return null; }
    }

    async verify(token, url) {
        try {
            const t = new URL(url).searchParams.get('token');
            if (!t) return false;
            const res = await axios.post(
                `${CONFIG.discord.apiBase}/auth/verify`,
                { token: t },
                { headers: { Authorization: token } }
            );
            return res.status === 200 || res.status === 204;
        } catch { return false; }
    }

    async save(data, token, verified) {
        const file = verified ? 'verified.txt' : 'unverified.txt';
        await fs.appendFile(path.join(__dirname, file), `${data.email}:${data.password}:${token}\n`);
    }
}

async function main() {
    console.log(chalk.green('[+] Starting...'));
    const g = new Generator();
    await g.create();
    console.log(chalk.green('[+] Done'));
    process.exit(0);
}

main().catch(console.error);
