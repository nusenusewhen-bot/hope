const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const chalk = require('chalk');

puppeteer.use(StealthPlugin());

// Load proxies from proxies.js
const { proxies } = require('./proxies.js');

const CONFIG = {
    hotmail007: {
        apiKey: process.env.HOTMAIL007_KEY || 'your-key-here',
        endpoint: 'https://gapi.hotmail007.com/api/mail/getMail'
    },
    discord: {
        registerUrl: 'https://discord.com/register',
        apiBase: 'https://discord.com/api/v9'
    },
    captcha: {
        geminiKey: process.env.GEMINI_KEY || 'your-key-here',
        groqKey: process.env.GROQ_KEY || 'your-key-here'
    },
    delays: {
        typing: { min: 50, max: 200 },
        action: { min: 500, max: 1500 },
        submit: { min: 2000, max: 4000 }
    }
};

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

class EmailProvider {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.baseUrl = 'https://gapi.hotmail007.com/api/mail';
    }

    async getEmail(type = 'outlook') {
        try {
            const response = await axios.get(`${this.baseUrl}/getMail`, {
                params: { clientKey: this.apiKey, mailType: type, quantity: 1 },
                timeout: 30000
            });

            if (response.data.success && response.data.data?.length > 0) {
                const account = response.data.data[0].split(':');
                return {
                    email: account[0],
                    password: account[1],
                    refreshToken: account[2],
                    clientId: account[3] || '9e5f94bc-e8a4-4e73-b8be-63364c29d753'
                };
            }
            return null;
        } catch (err) {
            console.log(chalk.red(`[Email Error] ${err.message}`));
            return null;
        }
    }

    async getVerificationEmail(refreshToken, clientId, timeout = 120000) {
        const accessToken = await this.getAccessToken(refreshToken, clientId);
        if (!accessToken) return null;

        const startTime = Date.now();
        while (Date.now() - startTime < timeout) {
            try {
                const response = await axios.get('https://graph.microsoft.com/v1.0/me/messages', {
                    headers: { Authorization: `Bearer ${accessToken}` },
                    params: { $top: 5, $orderby: 'receivedDateTime desc', $select: 'subject,body,from' }
                });

                for (const email of response.data.value) {
                    const from = email.from?.emailAddress?.address?.toLowerCase() || '';
                    const subject = email.subject?.toLowerCase() || '';
                    if (from.includes('discord') && (subject.includes('verify') || subject.includes('confirm'))) {
                        const verifyUrl = this.extractVerifyUrl(email.body.content);
                        if (verifyUrl) return verifyUrl;
                    }
                }
            } catch (err) {
                console.log(chalk.yellow(`[Email Check] ${err.message}`));
            }
            await this.sleep(5000);
        }
        return null;
    }

    async getAccessToken(refreshToken, clientId) {
        try {
            const cleanToken = refreshToken.endsWith('$') ? refreshToken.slice(0, -1) : refreshToken;
            const response = await axios.post('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
                client_id: clientId || '9e5f94bc-e8a4-4e73-b8be-63364c29d753',
                refresh_token: cleanToken,
                grant_type: 'refresh_token',
                scope: 'https://graph.microsoft.com/.default'
            });
            return response.data.access_token;
        } catch (err) {
            return null;
        }
    }

    extractVerifyUrl(htmlContent) {
        const match = htmlContent.match(/https:\/\/discord\.com\/verify\?token=[^"'\s]+/) 
            || htmlContent.match(/https:\/\/click\.discord\.com\/ls\/click\?[^"'\s]+/);
        return match ? match[0] : null;
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
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
        this.emailProvider = new EmailProvider(config.hotmail007.apiKey);
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
        const emailData = await this.emailProvider.getEmail();
        if (!emailData) {
            console.log(chalk.red('[!] Failed to get email'));
            return null;
        }

        console.log(chalk.cyan(`[+] Using email: ${emailData.email}`));

        const browserOptions = {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security', '--disable-features=IsolateOrigins,site-per-process']
        };

        if (proxy) browserOptions.args.push(`--proxy-server=${proxy.host}:${proxy.port}`);

        const browser = await puppeteer.launch(browserOptions);
        const page = await browser.newPage();

        try {
            await page.setViewport({ width: 1366, height: 768 });
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');

            await page.goto(this.config.discord.registerUrl, { waitUntil: 'networkidle2', timeout: 30000 });

            const username = this.generateUsername();
            const birthday = this.generateBirthday();

            await this.fillField(page, 'input[name="email"]', emailData.email);
            await this.fillField(page, 'input[name="username"]', username);
            await this.fillField(page, 'input[name="password"]', emailData.password);

            await this.setDropdown(page, 'Month', birthday.month);
            await this.setDropdown(page, 'Day', birthday.day.toString());
            await this.setDropdown(page, 'Year', birthday.year.toString());

            await page.evaluate(() => document.querySelectorAll('input[type="checkbox"]').forEach(cb => { if (!cb.checked) cb.click(); }));

            await this.humanLikeDelay('submit');
            await page.click('button[type="submit"]');

            const token = await this.handleCaptcha(page);
            if (!token) {
                console.log(chalk.red('[!] Failed to get token'));
                await browser.close();
                return null;
            }

            console.log(chalk.green(`[+] Token: ${token.substring(0, 20)}...`));

            const verifyUrl = await this.emailProvider.getVerificationEmail(emailData.refreshToken, emailData.clientId);
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
        await page.waitForSelector(selector);
        await page.click(selector);
        for (const char of value) {
            await page.keyboard.type(char, { delay: Math.floor(Math.random() * 150 + 50) });
        }
        await this.humanLikeDelay('action');
    }

    async setDropdown(page, label, value) {
        await page.waitForSelector(`div[role="button"][aria-label*="${label}"]`);
        await page.click(`div[role="button"][aria-label*="${label}"]`);
        await this.humanLikeDelay('action');
        await page.waitForSelector(`div[role="option"]:has-text("${value}")`);
        await page.click(`div[role="option"]:has-text("${value}")`);
        await this.humanLikeDelay('action');
    }

    async handleCaptcha(page) {
        try {
            await page.waitForSelector('iframe[src*="hcaptcha"]', { timeout: 10000 });
            const frames = await page.frames();
            const captchaFrame = frames.find(f => f.url().includes('hcaptcha'));
            if (!captchaFrame) return await this.extractToken(page);

            await captchaFrame.waitForSelector('#checkbox');
            await captchaFrame.click('#checkbox');
            await captchaFrame.waitForSelector('#menu-info', { timeout: 5000 });
            await captchaFrame.click('#menu-info');

            const menuItems = await captchaFrame.$$('[role="menuitem"]');
            for (const item of menuItems) {
                const text = await item.evaluate(el => el.textContent);
                if (text.includes('Accessibility') || text.includes('Toegankelijkheid')) {
                    await item.click();
                    break;
                }
            }

            await captchaFrame.waitForSelector('input[name="captcha"]');
            for (let i = 0; i < 15; i++) {
                const questionEl = await captchaFrame.$('[id^="prompt-text"]');
                if (!questionEl) break;
                
                const question = await questionEl.evaluate(el => el.textContent);
                const answer = await this.captchaSolver.solveWithAI(question);
                await captchaFrame.type('input[name="captcha"]', answer);
                await captchaFrame.click('.button-submit');
                await new Promise(r => setTimeout(r, 1000));
            }
            return await this.extractToken(page);
        } catch {
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
        await fs.appendFile(path.join(__dirname, filename), `${emailData.email}:${emailData.password}:${token}\n`);
    }
}

async function main() {
    console.log(chalk.green('[+] Starting generator...'));
    const generator = new DiscordGenerator(CONFIG);
    await generator.createAccount();
    console.log(chalk.green('[+] Done'));
    process.exit(0);
}

main().catch(console.error);
