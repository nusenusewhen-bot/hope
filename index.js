const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const RecaptchaPlugin = require('puppeteer-extra-plugin-recaptcha');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const chalk = require('chalk');
const readline = require('readline');

puppeteer.use(StealthPlugin());

// Configuration
const CONFIG = {
    hotmail007: {
        apiKey: 'fadaa82f20aa427bbee585c10782888d047559',
        endpoint: 'https://gapi.hotmail007.com/api/mail/getMail'
    },
    discord: {
        registerUrl: 'https://discord.com/register',
        apiBase: 'https://discord.com/api/v9'
    },
    captcha: {
        geminiKey: 'AIzaSyDD5n4NAr4J2FZGjmKswLFFBkT9XSD9GKc',
        groqKey: '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'
    },
    delays: {
        typing: { min: 50, max: 200 },
        action: { min: 500, max: 1500 },
        submit: { min: 2000, max: 4000 }
    }
};

class ProxyRotator {
    constructor(proxyFile = 'proxies.txt') {
        this.proxyFile = proxyFile;
        this.proxies = [];
        this.currentIndex = 0;
        this.workingProxies = new Set();
    }

    async loadProxies() {
        try {
            const data = await fs.readFile(this.proxyFile, 'utf8');
            this.proxies = data.split('\n')
                .map(line => line.trim())
                .filter(line => line && !line.startsWith('#'));
            console.log(chalk.green(`[+] Loaded ${this.proxies.length} proxies`));
        } catch (err) {
            console.log(chalk.yellow('[!] No proxy file found, running without proxies'));
        }
    }

    getNextProxy() {
        if (this.proxies.length === 0) return null;
        const proxy = this.proxies[this.currentIndex % this.proxies.length];
        this.currentIndex++;
        return this.parseProxy(proxy);
    }

    parseProxy(proxyString) {
        // Format: ip:port or ip:port:user:pass
        const parts = proxyString.split(':');
        if (parts.length === 2) {
            return {
                host: parts[0],
                port: parts[1],
                url: `http://${parts[0]}:${parts[1]}`
            };
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

    getAgent(proxy, type = 'http') {
        if (!proxy) return null;
        if (type === 'socks4' || type === 'socks5') {
            return new SocksProxyAgent(proxy.url);
        }
        return new HttpsProxyAgent(proxy.url);
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
                params: {
                    clientKey: this.apiKey,
                    mailType: type,
                    quantity: 1
                },
                timeout: 30000
            });

            if (response.data.success && response.data.data && response.data.data.length > 0) {
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
                    params: {
                        $top: 5,
                        $orderby: 'receivedDateTime desc',
                        $select: 'subject,body,from'
                    }
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
            console.log(chalk.red(`[Token Error] ${err.message}`));
            return null;
        }
    }

    extractVerifyUrl(htmlContent) {
        const patterns = [
            /https:\/\/discord\.com\/verify\?token=[^"'\s]+/,
            /https:\/\/click\.discord\.com\/ls\/click\?[^"'\s]+/
        ];

        for (const pattern of patterns) {
            const match = htmlContent.match(pattern);
            if (match) return match[0];
        }
        return null;
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
        
        if (this.knowledgeBase.has(lowerQ)) {
            return this.knowledgeBase.get(lowerQ);
        }

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
                    contents: [{
                        parts: [{
                            text: `Dutch yes/no CAPTCHA question. Answer ONLY 'ja' or 'nee'. Question: ${question}`
                        }]
                    }],
                    generationConfig: { temperature: 0, maxOutputTokens: 5 }
                },
                { timeout: 8000 }
            );

            const text = response.data.candidates[0].content.parts[0].text.toLowerCase();
            if (text.includes('ja') && !text.includes('nee')) return 'ja';
            if (text.includes('nee')) return 'nee';
            return null;
        } catch (err) {
            return null;
        }
    }

    async callGroq(question) {
        try {
            const response = await axios.post(
                'https://api.groq.com/openai/v1/chat/completions',
                {
                    model: 'llama-3.3-70b-versatile',
                    messages: [{
                        role: 'user',
                        content: `Dutch yes/no CAPTCHA. Answer ONLY 'ja' or 'nee'. Question: ${question}`
                    }],
                    temperature: 0,
                    max_tokens: 5
                },
                {
                    headers: { Authorization: `Bearer ${this.config.groqKey}` },
                    timeout: 8000 }
            );

            const text = response.data.choices[0].message.content.toLowerCase();
            if (text.includes('ja') && !text.includes('nee')) return 'ja';
            if (text.includes('nee')) return 'nee';
            return null;
        } catch (err) {
            return null;
        }
    }
}

class DiscordGenerator {
    constructor(config) {
        this.config = config;
        this.proxyRotator = new ProxyRotator();
        this.emailProvider = new EmailProvider(config.hotmail007.apiKey);
        this.captchaSolver = new CaptchaSolver(config.captcha);
        this.stats = { created: 0, verified: 0, failed: 0 };
    }

    async initialize() {
        await this.proxyRotator.loadProxies();
    }

    getRandomUserAgent() {
        const agents = [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
        ];
        return agents[Math.floor(Math.random() * agents.length)];
    }

    generateUsername() {
        const adjectives = ['Shadow', 'Silent', 'Hidden', 'Dark', 'Ghost', 'Cyber', 'Tech', 'Digital'];
        const nouns = ['Hunter', 'Walker', 'Wraith', 'Specter', 'Ninja', 'Coder', 'Ghost', 'Viper'];
        const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
        const noun = nouns[Math.floor(Math.random() * nouns.length)];
        const num = Math.floor(Math.random() * 99999);
        return `${adj}${noun}${num}`;
    }

    generateBirthday() {
        const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
        return {
            day: Math.floor(Math.random() * 28) + 1,
            month: months[Math.floor(Math.random() * months.length)],
            year: Math.floor(Math.random() * (2004 - 1990) + 1990)
        };
    }

    async humanLikeDelay(type = 'typing') {
        const range = this.config.delays[type] || this.config.delays.typing;
        const delay = Math.floor(Math.random() * (range.max - range.min) + range.min);
        await new Promise(resolve => setTimeout(resolve, delay));
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
            headless: false,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process',
                '--disable-site-isolation-trials'
            ]
        };

        if (proxy) {
            browserOptions.args.push(`--proxy-server=${proxy.host}:${proxy.port}`);
        }

        const browser = await puppeteer.launch(browserOptions);
        const page = await browser.newPage();

        try {
            await page.setViewport({ width: 1366, height: 768 });
            await page.setUserAgent(this.getRandomUserAgent());

            // Navigate to Discord register
            await page.goto(this.config.discord.registerUrl, { waitUntil: 'networkidle2', timeout: 30000 });

            const username = this.generateUsername();
            const birthday = this.generateBirthday();
            const password = emailData.password;

            // Fill form with human-like behavior
            await this.fillField(page, 'input[name="email"]', emailData.email);
            await this.fillField(page, 'input[name="username"]', username);
            await this.fillField(page, 'input[name="password"]', password);

            // Set birthday
            await this.setDropdown(page, 'Month', birthday.month);
            await this.setDropdown(page, 'Day', birthday.day.toString());
            await this.setDropdown(page, 'Year', birthday.year.toString());

            // Check TOS checkbox
            await page.evaluate(() => {
                const checkboxes = document.querySelectorAll('input[type="checkbox"]');
                checkboxes.forEach(cb => {
                    if (!cb.checked) cb.click();
                });
            });

            await this.humanLikeDelay('submit');
            await page.click('button[type="submit"]');

            // Handle captcha
            const token = await this.handleCaptcha(page);
            
            if (!token) {
                console.log(chalk.red('[!] Failed to get token'));
                await browser.close();
                return null;
            }

            console.log(chalk.green(`[+] Token obtained: ${token.substring(0, 20)}...`));

            // Verify email
            const verifyUrl = await this.emailProvider.getVerificationEmail(
                emailData.refreshToken,
                emailData.clientId
            );

            if (verifyUrl) {
                const verified = await this.verifyEmail(token, verifyUrl);
                if (verified) {
                    this.stats.verified++;
                    await this.saveToken(emailData, token, true);
                    console.log(chalk.green('[+] Account verified successfully'));
                } else {
                    await this.saveToken(emailData, token, false);
                }
            } else {
                await this.saveToken(emailData, token, false);
            }

            this.stats.created++;
            await browser.close();
            return token;

        } catch (err) {
            console.log(chalk.red(`[Error] ${err.message}`));
            await browser.close();
            this.stats.failed++;
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
        const dropdownSelector = `div[role="button"][aria-label*="${label}"]`;
        await page.waitForSelector(dropdownSelector);
        await page.click(dropdownSelector);
        
        await this.humanLikeDelay('action');
        
        const optionSelector = `div[role="option"]:has-text("${value}")`;
        await page.waitForSelector(optionSelector);
        await page.click(optionSelector);
        
        await this.humanLikeDelay('action');
    }

    async handleCaptcha(page) {
        try {
            // Wait for captcha iframe
            await page.waitForSelector('iframe[src*="hcaptcha"]', { timeout: 10000 });
            
            const frames = await page.frames();
            const captchaFrame = frames.find(f => f.url().includes('hcaptcha'));

            if (!captchaFrame) {
                // Check if already passed (passive)
                const token = await this.extractToken(page);
                if (token) return token;
                return null;
            }

            // Click checkbox
            await captchaFrame.waitForSelector('#checkbox');
            await captchaFrame.click('#checkbox');

            // Wait for challenge
            await captchaFrame.waitForSelector('#menu-info', { timeout: 5000 });
            await captchaFrame.click('#menu-info');

            // Open accessibility challenge
            await captchaFrame.waitForSelector('[role="menuitem"]');
            const menuItems = await captchaFrame.$$('[role="menuitem"]');
            
            for (const item of menuItems) {
                const text = await item.evaluate(el => el.textContent);
                if (text.includes('Accessibility') || text.includes('Toegankelijkheid')) {
                    await item.click();
                    break;
                }
            }

            // Solve questions
            await captchaFrame.waitForSelector('input[name="captcha"]');
            
            let solved = false;
            let attempts = 0;
            const maxAttempts = 15;

            while (!solved && attempts < maxAttempts) {
                const questionEl = await captchaFrame.$('[id^="prompt-text"]');
                if (!questionEl) {
                    // Check if solved
                    const token = await this.extractToken(page);
                    if (token) return token;
                    break;
                }

                const question = await questionEl.evaluate(el => el.textContent);
                console.log(chalk.yellow(`[Captcha] ${question}`));

                const answer = await this.captchaSolver.solveWithAI(question);
                console.log(chalk.cyan(`[Answer] ${answer}`));

                await captchaFrame.type('input[name="captcha"]', answer);
                await captchaFrame.click('.button-submit');

                await this.sleep(1000);
                attempts++;
            }

            return await this.extractToken(page);

        } catch (err) {
            console.log(chalk.yellow(`[Captcha Warning] ${err.message}`));
            return await this.extractToken(page);
        }
    }

    async extractToken(page) {
        try {
            const token = await page.evaluate(() => {
                return localStorage.getItem('token');
            });
            return token ? token.replace(/"/g, '') : null;
        } catch {
            return null;
        }
    }

    async verifyEmail(token, verifyUrl) {
        try {
            // Extract token from URL
            const urlToken = new URL(verifyUrl).searchParams.get('token');
            if (!urlToken) return false;

            const response = await axios.post(
                `${this.config.discord.apiBase}/auth/verify`,
                { token: urlToken },
                {
                    headers: {
                        'Authorization': token,
                        'Content-Type': 'application/json'
                    }
                }
            );

            return response.status === 200 || response.status === 204;
        } catch (err) {
            console.log(chalk.red(`[Verify Error] ${err.message}`));
            return false;
        }
    }

    async saveToken(emailData, token, verified) {
        const filename = verified ? 'verified.txt' : 'unverified.txt';
        const line = `${emailData.email}:${emailData.password}:${token}\n`;
        await fs.appendFile(path.join(__dirname, filename), line);
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    printStats() {
        console.log(chalk.blue('\n[Stats] ' +
            `Created: ${this.stats.created} | ` +
            `Verified: ${this.stats.verified} | ` +
            `Failed: ${this.stats.failed}`
        ));
    }
}

// Main execution
async function main() {
    console.log(chalk.green(`
    ██████╗ ██╗███████╗ ██████╗ ██████╗ ██████╗ ██████╗ 
    ██╔══██╗██║██╔════╝██╔════╝██╔═══██╗██╔══██╗██╔══██╗
    ██║  ██║██║███████╗██║     ██║   ██║██████╔╝██║  ██║
    ██║  ██║██║╚════██║██║     ██║   ██║██╔══██╗██║  ██║
    ██████╔╝██║███████║╚██████╗╚██████╔╝██║  ██║██████╔╝
    ╚═════╝ ╚═╝╚══════╝ ╚═════╝ ╚═════╝ ╚═╝  ╚═╝╚═════╝ 
    `));

    const generator = new DiscordGenerator(CONFIG);
    await generator.initialize();

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    const count = await new Promise(resolve => {
        rl.question('How many accounts to generate? (0=infinite): ', answer => {
            resolve(parseInt(answer) || 1);
        });
    });

    rl.close();

    const targetCount = count === 0 ? Infinity : count;

    for (let i = 0; i < targetCount; i++) {
        console.log(chalk.blue(`\n[${i + 1}/${targetCount === Infinity ? '∞' : targetCount}] Creating account...`));
        await generator.createAccount();
        generator.printStats();

        if (i < targetCount - 1) {
            await generator.sleep(5000 + Math.random() * 5000);
        }
    }

    console.log(chalk.green('\n[+] Done!'));
    process.exit(0);
}

main().catch(console.error);
