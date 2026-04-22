const express = require('express');
const axios = require('axios');
const { Client, GatewayIntentBits, Partials } = require('discord.js-selfbot-v13');
const tlsClient = require('tls-client');
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

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// Proxy management
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
        console.log('[PROXY] No proxy file found, using direct connection');
    }
}

function getNextProxy() {
    if (proxies.length === 0) return null;
    const proxy = proxies[currentProxyIndex % proxies.length];
    currentProxyIndex++;
    return proxy;
}

// NopeCHA CAPTCHA solver
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

        // Poll for solution
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

// Discord token fetch via REST API (like your working Python code)
async function fetchDiscordToken(email, password, proxy = null) {
    try {
        const session = new tlsClient.Session({
            clientIdentifier: 'chrome_131',
            randomTlsExtensionOrder: true,
            ...(proxy && { proxy: proxy.startsWith('http') ? proxy : `http://${proxy}` })
        });

        const response = await session.post('https://discord.com/api/v9/auth/login', {
            headers: {
                'accept': '*/*',
                'accept-language': 'en-US,en;q=0.9',
                'content-type': 'application/json',
                'origin': 'https://discord.com',
                'referer': 'https://discord.com/channels/@me',
                'sec-ch-ua': '"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"Windows"',
                'sec-fetch-dest': 'empty',
                'sec-fetch-mode': 'cors',
                'sec-fetch-site': 'same-origin',
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
                'x-discord-timezone': 'Asia/Calcutta',
                'x-super-properties': 'eyJvcyI6IldpbmRvd3MiLCJicm93c2VyIjoiQ2hyb21lIiwiZGV2aWNlIjoiIiwic3lzdGVtX2xvY2FsZSI6ImVuLVVTIiwiaGFzX2NsaWVudF9tb2RzIjpmYWxzZSwiYnJvd3Nlcl91c2VyX2FnZW50IjoiTW96aWxsYS81LjAgKFdpbmRvd3MgTlQgMTAuMDsgV2luNjQ7IHg2NCkgQXBwbGVXZWJLaXQvNTM3LjM2IChLSFRNTCwgbGlrZSBHZWNrbykgQ2hyb21lLzEzNC4wLjAuMCBTYWZhcmkvNTM3LjM2IiwiYnJvd3Nlcl92ZXJzaW9uIjoiMTM0LjAuMC4wIiwib3NfdmVyc2lvbiI6IjEwIiwicmVmZXJyZXIiOiIiLCJyZWZlcnJpbmdfZG9tYWluIjoiIiwicmVmZXJyZXJfY3VycmVudCI6IiIsInJlZmVycmluZ19kb21haW5fY3VycmVudCI6IiIsInJlbGVhc2VfY2hhbm5lbCI6InN0YWJsZSIsImNsaWVudF9idWlsZF9udW1iZXIiOjM4NDg4NywiY2xpZW50X2V2ZW50X3NvdXJjZSI6bnVsbH0='
            },
            body: JSON.stringify({
                gift_code_sku_id: null,
                login: email,
                login_source: null,
                password: password,
                undelete: false
            }),
            timeout: 15000
        });

        if (response.status !== 200) {
            console.log(`[TOKEN] Login failed: HTTP ${response.status}`);
            return null;
        }

        const data = JSON.parse(response.body);
        return data.token || null;
    } catch (e) {
        console.log('[TOKEN] Error fetching token:', e.message);
        return null;
    }
}

// Generate random credentials
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

// Check token validity
async function checkToken(token) {
    try {
        const session = new tlsClient.Session({
            clientIdentifier: 'chrome_138',
            randomTlsExtensionOrder: true
        });

        const response = await session.get('https://discordapp.com/api/v9/users/@me/library', {
            headers: {
                'Authorization': token,
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
            },
            timeout: 10000
        });

        if (response.status === 200) return 'VALID';
        if (response.status === 403) return 'LOCKED';
        if (response.status === 401) return 'INVALID';
        return 'ERROR';
    } catch (e) {
        return 'ERROR';
    }
}

// Save account to file
function saveAccount(email, password, token, status) {
    try {
        const file = status === 'VALID' ? 'valid.txt' : status === 'LOCKED' ? 'locked.txt' : 'invalid.txt';
        const line = status === 'VALID' ? `${email}:${password}:${token}\n` : `${token}\n`;
        fs.appendFileSync(path.join(OUTPUT_DIR, file), line);
        console.log(`[SAVE] Account saved to ${file}`);
        return true;
    } catch (e) {
        console.log('[SAVE] Error:', e.message);
        return false;
    }
}

// Main account generator worker
async function generateAccount() {
    console.log('\n[GEN] Starting account generation...');
    
    const proxy = getNextProxy();
    if (proxy) console.log(`[GEN] Using proxy: ${proxy}`);
    else console.log('[GEN] No proxy available, using direct connection');

    const email = generateEmail();
    const password = generatePassword();
    const username = generateUsername();
    const displayName = username;

    console.log(`[GEN] Email: ${email}`);
    console.log(`[GEN] Username: ${username}`);

    let browser;
    try {
        // Launch browser with NopeCHA extension
        const extensionPath = path.join(__dirname, 'nopecha_ext');
        const args = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--window-size=1280,720',
            '--disable-blink-features=AutomationControlled',
            ...(fs.existsSync(extensionPath) ? [
                `--load-extension=${extensionPath}`,
                `--disable-extensions-except=${extensionPath}`
            ] : []),
            ...(proxy ? [`--proxy-server=${proxy}`] : [])
        ];

        browser = await puppeteer.launch({
            headless: true,
            args,
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined
        });

        const page = await browser.newPage();
        
        // Set viewport and user agent
        await page.setViewport({ width: 1280, height: 720 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36');

        // Navigate to Discord register
        console.log('[GEN] Navigating to Discord register...');
        await page.goto('https://discord.com/register', { waitUntil: 'networkidle2', timeout: 30000 });

        // Wait for form
        await page.waitForSelector('input[name="email"]', { timeout: 10000 });

        // Fill form
        console.log('[GEN] Filling registration form...');
        await page.type('input[name="email"]', email, { delay: 50 });
        await page.type('input[name="global_name"]', displayName, { delay: 50 });
        await page.type('input[name="username"]', username, { delay: 50 });
        await page.type('input[aria-label="Password"]', password, { delay: 50 });

        // Fill DOB
        const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
        const month = months[Math.floor(Math.random() * months.length)];
        const day = Math.floor(Math.random() * 28) + 1;
        const year = Math.floor(Math.random() * 20) + 1980;

        // Click and select month
        await page.click('div[role="combobox"]:has-text("Month")');
        await page.waitForTimeout(200);
        await page.click(`div[role="option"]:has-text("${month}")`);

        // Day
        await page.click('div[role="combobox"]:has-text("Day")');
        await page.waitForTimeout(200);
        await page.click(`div[role="option"]:has-text("${day}")`);

        // Year
        await page.click('div[role="combobox"]:has-text("Year")');
        await page.waitForTimeout(200);
        await page.click(`div[role="option"]:has-text("${year}")`);

        // Check TOS checkbox
        await page.click('input[type="checkbox"]');

        // Submit
        console.log('[GEN] Submitting form...');
        await page.click('button[type="submit"]');

        // Wait for CAPTCHA or redirect
        console.log('[GEN] Waiting for CAPTCHA or redirect...');
        await page.waitForTimeout(5000);

        // Check if hCaptcha appeared
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
                    // Inject solution
                    await page.evaluate((sol) => {
                        document.querySelector('textarea[name="h-captcha-response"]').value = sol;
                        document.querySelector('#hcap-script').dispatchEvent(new Event('submit'));
                    }, solution);
                    
                    await page.waitForTimeout(3000);
                }
            }
        }

        // Wait for redirect to success page
        let attempts = 0;
        let token = null;
        
        while (attempts < 30 && !token) {
            await page.waitForTimeout(2000);
            const url = page.url();
            
            if (url.includes('/channels/@me') || url.includes('/verify')) {
                console.log('[GEN] Account created! Extracting token...');
                
                // Try to get token from localStorage
                token = await page.evaluate(() => localStorage.getItem('token'));
                if (token) token = token.replace(/^"|"$/g, '');
                
                if (!token) {
                    // Fallback to API login
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

        console.log(`[GEN] Token obtained: ${token.substring(0, 20)}...`);

        // Verify email (if possible)
        console.log('[GEN] Checking token status...');
        const status = await checkToken(token);
        console.log(`[GEN] Token status: ${status}`);

        // Save
        saveAccount(email, password, token, status);

        await browser.close();
        return { email, password, token, status };

    } catch (e) {
        console.log('[GEN] Error:', e.message);
        if (browser) await browser.close();
        return null;
    }
}

// Express routes
app.get('/', (req, res) => {
    res.json({
        status: 'Discord Account Generator',
        nopecha: 'Enabled',
        proxy: proxies.length > 0 ? `${proxies.length} loaded` : 'Direct connection',
        endpoints: {
            '/generate': 'POST - Generate 1 account immediately',
            '/status': 'GET - Check generator status'
        }
    });
});

app.post('/generate', async (req, res) => {
    const account = await generateAccount();
    if (account) {
        res.json({
            success: true,
            account: {
                email: account.email,
                password: account.password,
                token: account.token,
                status: account.status
            }
        });
    } else {
        res.json({ success: false, error: 'Account generation failed' });
    }
});

app.get('/status', (req, res) => {
    const valid = fs.existsSync(path.join(OUTPUT_DIR, 'valid.txt')) ? fs.readFileSync(path.join(OUTPUT_DIR, 'valid.txt'), 'utf8').split('\n').filter(Boolean).length : 0;
    const total = fs.readdirSync(OUTPUT_DIR).reduce((acc, f) => acc + (fs.readFileSync(path.join(OUTPUT_DIR, f), 'utf8').split('\n').filter(Boolean).length), 0);
    
    res.json({
        proxies: proxies.length,
        accounts_generated: total,
        valid_accounts: valid,
        nopecha_key: NOPECHA_KEY.substring(0, 8) + '...'
    });
});

// Auto-start generation on boot
async function autoStart() {
    loadProxies();
    console.log('[BOOT] Auto-starting account generation in 5 seconds...');
    await new Promise(r => setTimeout(r, 5000));
    
    // Generate first account immediately
    const account = await generateAccount();
    if (account && account.status === 'VALID') {
        console.log('[BOOT] First account generated successfully!');
    } else {
        console.log('[BOOT] First attempt failed, will retry on next request');
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[SERVER] Generator running on port ${PORT}`);
    autoStart();
});
