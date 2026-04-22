const express = require('express');
const axios = require('axios');
const https = require('https');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json());

const NOPECHA_KEY = 'cvakjtwvpsuwwf0c';
const OUTPUT_DIR = path.join(__dirname, 'output');
const PROXY_FILE = path.join(__dirname, 'proxies.txt');

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

let proxies = [];
let currentProxyIndex = 0;

function loadProxies() {
    try {
        if (fs.existsSync(PROXY_FILE)) {
            const data = fs.readFileSync(PROXY_FILE, 'utf8');
            proxies = data.split('\n').map(p => p.trim()).filter(p => p && !p.startsWith('#'));
            console.log(`[PROXY] Loaded ${proxies.length} proxies`);
        }
    } catch (e) {
        console.log('[PROXY] No proxy file, using direct connection');
    }
}

function getNextProxy() {
    if (proxies.length === 0) return null;
    const proxy = proxies[currentProxyIndex % proxies.length];
    currentProxyIndex++;
    return proxy;
}

async function solveCaptchaWithNopeCHA(siteKey, pageUrl, proxy = null) {
    try {
        console.log('[NOPECHA] Requesting CAPTCHA solve...');
        const createTaskRes = await axios.post('https://api.nopecha.com/v1/captcha', {
            key: NOPECHA_KEY,
            type: 'hcaptcha',
            sitekey: siteKey,
            url: pageUrl,
            ...(proxy && { proxy })
        }, { timeout: 30000 });

        if (!createTaskRes.data.data) {
            console.log('[NOPECHA] Failed to create task:', createTaskRes.data);
            return null;
        }

        const taskId = createTaskRes.data.data;
        console.log(`[NOPECHA] Task created: ${taskId}`);

        for (let i = 0; i < 60; i++) {
            await new Promise(r => setTimeout(r, 5000));
            const checkRes = await axios.get('https://api.nopecha.com/v1/status', {
                params: { key: NOPECHA_KEY, id: taskId },
                timeout: 10000
            });

            if (checkRes.data.data) {
                console.log('[NOPECHA] CAPTCHA solved!');
                return checkRes.data.data;
            }
            console.log(`[NOPECHA] Polling... (${i + 1}/60)`);
        }
        return null;
    } catch (e) {
        console.log('[NOPECHA] Error:', e.message);
        return null;
    }
}

// Native HTTPS request instead of tls-client
function makeDiscordRequest(email, password, proxy = null) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({
            gift_code_sku_id: null,
            login: email,
            login_source: null,
            password: password,
            undelete: false
        });

        const options = {
            hostname: 'discord.com',
            port: 443,
            path: '/api/v9/auth/login',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData),
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
                'Accept': '*/*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Origin': 'https://discord.com',
                'Referer': 'https://discord.com/channels/@me',
                'Sec-Ch-Ua': '"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"',
                'Sec-Ch-Ua-Mobile': '?0',
                'Sec-Ch-Ua-Platform': '"Windows"',
                'Sec-Fetch-Dest': 'empty',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Site': 'same-origin',
                'X-Discord-Timezone': 'Asia/Calcutta',
                'X-Super-Properties': 'eyJvcyI6IldpbmRvd3MiLCJicm93c2VyIjoiQ2hyb21lIiwiZGV2aWNlIjoiIiwic3lzdGVtX2xvY2FsZSI6ImVuLVVTIiwiaGFzX2NsaWVudF9tb2RzIjpmYWxzZSwiYnJvd3Nlcl91c2VyX2FnZW50IjoiTW96aWxsYS81LjAgKFdpbmRvd3MgTlQgMTAuMDsgV2luNjQ7IHg2NCkgQXBwbGVXZWJLaXQvNTM3LjM2IChLSFRNTCwgbGlrZSBHZWNrbykgQ2hyb21lLzEzNC4wLjAuMCBTYWZhcmIvNTM3LjM2IiwiYnJvd3Nlcl92ZXJzaW9uIjoiMTM0LjAuMC4wIiwib3NfdmVyc2lvbiI6IjEwIiwicmVmZXJyZXIiOiIiLCJyZWZlcnJpbmdfZG9tYWluIjoiIiwicmVmZXJyZXJfY3VycmVudCI6IiIsInJlZmVycmluZ19kb21haW5fY3VycmVudCI6IiIsInJlbGVhc2VfY2hhbm5lbCI6InN0YWJsZSIsImNsaWVudF9idWlsZF9udW1iZXIiOjM4NDg4NywiY2xpZW50X2V2ZW50X3NvdXJjZSI6bnVsbH0='
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve({ status: res.statusCode, data: parsed });
                } catch (e) {
                    resolve({ status: res.statusCode, data: null, raw: data });
                }
            });
        });

        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

async function fetchDiscordToken(email, password, proxy = null) {
    try {
        const result = await makeDiscordRequest(email, password, proxy);
        if (result.status !== 200) {
            console.log(`[TOKEN] Login failed: HTTP ${result.status}`);
            return null;
        }
        return result.data?.token || null;
    } catch (e) {
        console.log('[TOKEN] Error:', e.message);
        return null;
    }
}

function generateUsername() {
    const adjectives = ['Cool', 'Epic', 'Super', 'Mega', 'Ultra', 'Pro', 'Elite', 'Master', 'Dark', 'Light'];
    const nouns = ['Gamer', 'Player', 'User', 'Hero', 'Legend', 'Champion', 'Warrior', 'Ninja', 'Shadow', 'Ghost'];
    return `${adjectives[Math.floor(Math.random() * adjectives.length)]}${nouns[Math.floor(Math.random() * nouns.length)]}${Math.floor(Math.random() * 999999)}`;
}

function generatePassword() {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
    let pwd = '';
    for (let i = 0; i < 16; i++) pwd += chars[Math.floor(Math.random() * chars.length)];
    return pwd;
}

function generateEmail() {
    const local = Math.random().toString(36).substring(2, 14);
    const domains = ['outlook.com', 'hotmail.com', 'gmail.com', 'yahoo.com', 'proton.me'];
    return `${local}@${domains[Math.floor(Math.random() * domains.length)]}`;
}

async function checkToken(token) {
    return new Promise((resolve) => {
        const options = {
            hostname: 'discordapp.com',
            port: 443,
            path: '/api/v9/users/@me/library',
            method: 'GET',
            headers: {
                'Authorization': token,
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
            }
        };

        const req = https.request(options, (res) => {
            if (res.statusCode === 200) resolve('VALID');
            else if (res.statusCode === 403) resolve('LOCKED');
            else if (res.statusCode === 401) resolve('INVALID');
            else resolve('ERROR');
        });

        req.on('error', () => resolve('ERROR'));
        req.end();
    });
}

function saveAccount(email, password, token, status) {
    try {
        const file = status === 'VALID' ? 'valid.txt' : status === 'LOCKED' ? 'locked.txt' : 'invalid.txt';
        const line = status === 'VALID' ? `${email}:${password}:${token}\n` : `${token}\n`;
        fs.appendFileSync(path.join(OUTPUT_DIR, file), line);
        console.log(`[SAVE] Saved to ${file}`);
        return true;
    } catch (e) {
        console.log('[SAVE] Error:', e.message);
        return false;
    }
}

async function generateAccount() {
    console.log('\n[GEN] Starting account generation...');
    
    const proxy = getNextProxy();
    if (proxy) console.log(`[GEN] Using proxy: ${proxy}`);
    else console.log('[GEN] No proxy, using direct connection');

    const email = generateEmail();
    const password = generatePassword();
    const username = generateUsername();
    const displayName = username;

    console.log(`[GEN] Email: ${email}`);
    console.log(`[GEN] Username: ${username}`);

    let browser;
    try {
        const args = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--window-size=1280,720',
            '--disable-blink-features=AutomationControlled'
        ];

        const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser';

        browser = await puppeteer.launch({
            headless: true,
            args,
            executablePath: fs.existsSync(executablePath) ? executablePath : undefined
        });

        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 720 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36');

        console.log('[GEN] Navigating to Discord register...');
        await page.goto('https://discord.com/register', { waitUntil: 'networkidle2', timeout: 30000 });

        await page.waitForSelector('input[name="email"]', { timeout: 10000 });

        console.log('[GEN] Filling form...');
        await page.type('input[name="email"]', email, { delay: 50 });
        await page.type('input[name="global_name"]', displayName, { delay: 50 });
        await page.type('input[name="username"]', username, { delay: 50 });
        await page.type('input[aria-label="Password"]', password, { delay: 50 });

        const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
        const month = months[Math.floor(Math.random() * months.length)];
        const day = Math.floor(Math.random() * 28) + 1;
        const year = Math.floor(Math.random() * 20) + 1980;

        await page.click('div[role="combobox"]:has-text("Month")');
        await page.waitForTimeout(200);
        await page.click(`div[role="option"]:has-text("${month}")`);

        await page.click('div[role="combobox"]:has-text("Day")');
        await page.waitForTimeout(200);
        await page.click(`div[role="option"]:has-text("${day}")`);

        await page.click('div[role="combobox"]:has-text("Year")');
        await page.waitForTimeout(200);
        await page.click(`div[role="option"]:has-text("${year}")`);

        await page.click('input[type="checkbox"]');
        await page.click('button[type="submit"]');

        console.log('[GEN] Waiting for CAPTCHA or redirect...');
        await page.waitForTimeout(5000);

        const captchaFrame = await page.$('iframe[src*="hcaptcha"]');
        if (captchaFrame) {
            console.log('[GEN] CAPTCHA detected, solving with NopeCHA...');
            const siteKey = await page.evaluate(() => {
                const el = document.querySelector('[data-sitekey]');
                return el ? el.getAttribute('data-sitekey') : null;
            });

            if (siteKey) {
                const solution = await solveCaptchaWithNopeCHA(siteKey, page.url(), proxy);
                if (solution) {
                    await page.evaluate((sol) => {
                        const textarea = document.querySelector('textarea[name="h-captcha-response"]');
                        if (textarea) textarea.value = sol;
                        const script = document.querySelector('#hcap-script');
                        if (script) script.dispatchEvent(new Event('submit'));
                    }, solution);
                    await page.waitForTimeout(3000);
                }
            }
        }

        let attempts = 0;
        let token = null;
        
        while (attempts < 30 && !token) {
            await page.waitForTimeout(2000);
            const url = page.url();
            
            if (url.includes('/channels/@me') || url.includes('/verify')) {
                console.log('[GEN] Account created! Extracting token...');
                token = await page.evaluate(() => localStorage.getItem('token'));
                if (token) token = token.replace(/^"|"$/g, '');
                
                if (!token) {
                    token = await fetchDiscordToken(email, password, proxy);
                }
                break;
            }
            attempts++;
        }

        if (!token) {
            console.log('[GEN] Failed to get token');
            await browser.close();
            return null;
        }

        console.log(`[GEN] Token: ${token.substring(0, 20)}...`);
        const status = await checkToken(token);
        console.log(`[GEN] Status: ${status}`);
        saveAccount(email, password, token, status);

        await browser.close();
        return { email, password, token, status };

    } catch (e) {
        console.log('[GEN] Error:', e.message);
        if (browser) await browser.close();
        return null;
    }
}

app.get('/', (req, res) => {
    res.json({
        status: 'Discord Account Generator',
        nopecha: 'Enabled',
        proxy: proxies.length > 0 ? `${proxies.length} loaded` : 'Direct connection',
        endpoints: { '/generate': 'POST - Generate 1 account', '/status': 'GET - Check status' }
    });
});

app.post('/generate', async (req, res) => {
    const account = await generateAccount();
    if (account) {
        res.json({ success: true, account: { email: account.email, password: account.password, token: account.token, status: account.status } });
    } else {
        res.json({ success: false, error: 'Generation failed' });
    }
});

app.get('/status', (req, res) => {
    const valid = fs.existsSync(path.join(OUTPUT_DIR, 'valid.txt')) ? fs.readFileSync(path.join(OUTPUT_DIR, 'valid.txt'), 'utf8').split('\n').filter(Boolean).length : 0;
    const total = fs.readdirSync(OUTPUT_DIR).reduce((acc, f) => acc + (fs.readFileSync(path.join(OUTPUT_DIR, f), 'utf8').split('\n').filter(Boolean).length), 0);
    res.json({ proxies: proxies.length, accounts_generated: total, valid_accounts: valid, nopecha_key: NOPECHA_KEY.substring(0, 8) + '...' });
});

async function autoStart() {
    loadProxies();
    console.log('[BOOT] Auto-starting in 5 seconds...');
    await new Promise(r => setTimeout(r, 5000));
    const account = await generateAccount();
    if (account && account.status === 'VALID') {
        console.log('[BOOT] First account generated!');
    } else {
        console.log('[BOOT] First attempt failed');
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[SERVER] Generator on port ${PORT}`);
    autoStart();
});
