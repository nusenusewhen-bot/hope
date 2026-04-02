const { firefox } = require('playwright');
const chalk = require('chalk');
const config = require('./config');

class StealthBrowser {
    constructor(proxy) {
        this.proxy = proxy;
        this.browser = null;
        this.page = null;
    }

    async launch() {
        const proxyServer = this.proxy.type === 'socks5'
            ? `socks5://${this.proxy.ip}:${this.proxy.port}`
            : `http://${this.proxy.ip}:${this.proxy.port}`;

        this.browser = await firefox.launch({
            headless: config.HEADLESS,
            proxy: { server: proxyServer }
        });

        const context = await this.browser.newContext({
            viewport: { width: 1366, height: 768 },
            locale: 'en-US',
            timezoneId: 'America/New_York',
            colorScheme: 'dark'
        });

        await context.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            Object.defineProperty(navigator, 'plugins', { get: () => [{name: 'PDF Viewer'}] });
            delete window.__webdriver_script_fn;
        });

        this.page = await context.newPage();
        
        await this.page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'DNT': '1'
        });

        return this;
    }

    async goto(url) {
        await this.page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
        await this.delay(config.DELAY_MIN, config.DELAY_MAX);
    }

    async delay(min, max) {
        const ms = Math.floor(Math.random() * (max - min) + min);
        await this.page.waitForTimeout(ms);
    }

    async type(selector, text) {
        const el = this.page.locator(selector).first();
        await el.click({ delay: Math.random() * 100 + 50 });
        await this.delay(100, 300);
        
        const wpm = 35 + Math.random() * 25;
        const msPerChar = 60000 / (wpm * 5);
        
        for (const char of text) {
            await el.type(char, { delay: msPerChar * (0.5 + Math.random()) });
            if (Math.random() < 0.03) await this.delay(200, 500);
        }
        
        await this.delay();
    }

    async selectDropdown(index, value) {
        const dropdowns = await this.page.locator('div[role="button"][aria-haspopup="listbox"]').all();
        if (dropdowns[index]) {
            await dropdowns[index].click();
            await this.delay(200, 500);
            await this.page.locator('[role="option"]', { hasText: value }).first().click();
            await this.delay(300, 600);
        }
    }

    async close() {
        if (this.browser) await this.browser.close();
    }
}

module.exports = { StealthBrowser };
