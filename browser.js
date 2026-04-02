const { firefox } = require('playwright');
const chalk = require('chalk');

class StealthBrowser {
    constructor(proxy) {
        this.proxy = proxy;
        this.browser = null;
        this.context = null;
        this.page = null;
    }

    async launch() {
        const proxyServer = this.proxy.type === 'socks5' 
            ? `socks5://${this.proxy.ip}:${this.proxy.port}`
            : `http://${this.proxy.ip}:${this.proxy.port}`;

        this.browser = await firefox.launch({
            headless: false,
            proxy: { server: proxyServer }
        });

        this.context = await this.browser.newContext({
            viewport: { width: 1366, height: 768 },
            locale: 'en-US',
            timezoneId: 'America/New_York',
            colorScheme: 'dark',
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0'
        });

        // Inject anti-detection scripts
        await this.context.addInitScript(() => {
            // Override webdriver
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            
            // Fake plugins
            Object.defineProperty(navigator, 'plugins', { 
                get: () => [
                    { name: 'PDF Viewer', filename: 'internal-pdf-viewer' },
                    { name: 'Widevine Content Decryption Module', filename: 'widevinecdmadapter.dll' }
                ] 
            });
            
            // Fake mimeTypes
            Object.defineProperty(navigator, 'mimeTypes', {
                get: () => [
                    { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' }
                ]
            });
            
            // Remove automation indicators
            delete window.__webdriver_script_fn;
            delete navigator.__proto__.webdriver;
        });

        this.page = await this.context.newPage();
        
        // Set extra headers
        await this.page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            'DNT': '1',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1'
        });

        return this;
    }

    async navigate(url) {
        await this.page.goto(url, { 
            waitUntil: 'networkidle',
            timeout: 60000 
        });
        
        // Random delay after navigation
        await this.humanDelay(2000, 4000);
    }

    async humanDelay(min = 500, max = 2000) {
        const delay = Math.floor(Math.random() * (max - min) + min);
        await this.page.waitForTimeout(delay);
    }

    async typeHuman(selector, text) {
        const element = await this.page.locator(selector).first();
        
        // Click with human-like behavior
        await element.click({ delay: Math.random() * 100 + 50 });
        await this.humanDelay(100, 300);
        
        // Type with variable speed (30-60 WPM)
        const wpm = 30 + Math.random() * 30;
        const msPerChar = 60000 / (wpm * 5);
        
        for (let i = 0; i < text.length; i++) {
            await element.type(text[i], { delay: msPerChar * (0.5 + Math.random()) });
            
            // Occasional pause
            if (Math.random() < 0.03) {
                await this.humanDelay(300, 800);
            }
        }
        
        await this.humanDelay();
    }

    async selectDropdown(index, value) {
        const dropdowns = await this.page.locator('div[role="button"][aria-haspopup="listbox"]').all();
        if (dropdowns[index]) {
            await dropdowns[index].click();
            await this.humanDelay(300, 600);
            
            await this.page.locator('[role="option"]', { hasText: value }).first().click();
            await this.humanDelay(400, 800);
        }
    }

    async close() {
        if (this.browser) await this.browser.close();
    }
}

module.exports = { StealthBrowser };
