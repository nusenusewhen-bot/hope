const fs = require('fs-extra');
const chalk = require('chalk');
const { StealthBrowser } = require('./browser');
const { CaptchaSolver } = require('./captcha');
const config = require('./config');

class Generator {
    constructor() {
        this.solver = new CaptchaSolver();
        this.stats = { attempts: 0, success: 0, failed: 0 };
    }

    randomUser() {
        const adj = ['Shadow','Silent','Dark','Ghost','Cyber','Neon','Phantom'][Math.floor(Math.random()*7)];
        const noun = ['Hunter','Wraith','Ninja','Coder','Spectre'][Math.floor(Math.random()*5)];
        const num = Math.floor(Math.random()*99999);
        const user = `${adj}${noun}${num}`;
        return {
            username: user,
            email: `${user.toLowerCase()}${num}@gmail.com`,
            password: Array(16).fill(0).map(() => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*'[Math.floor(Math.random()*72)]).join(''),
            dob: {
                month: ['January','February','March','April','May','June','July','August','September','October','November','December'][Math.floor(Math.random()*12)],
                day: Math.floor(Math.random()*28+1).toString(),
                year: Math.floor(Math.random()*(2004-1990)+1990).toString()
            }
        };
    }

    async generate(proxy) {
        this.stats.attempts++;
        const browser = new StealthBrowser(proxy);
        let token = null;

        try {
            console.log(chalk.blue(`\n[Gen] Using ${proxy.id}`));
            await browser.launch();
            await browser.goto('https://discord.com/register');

            // Check flagged
            const flagged = await browser.page.locator('iframe[src*="hcaptcha"]').count() > 0;
            if (flagged) throw new Error('Flagged IP');

            const user = this.randomUser();
            console.log(chalk.gray(`  ${user.email}`));

            // Fill form
            await browser.type('input[type="email"]', user.email);
            await browser.type('input[name="username"]', user.username);
            await browser.type('input[type="password"]', user.password);
            await browser.selectDropdown(0, user.dob.month);
            await browser.selectDropdown(1, user.dob.day);
            await browser.selectDropdown(2, user.dob.year);
            
            await browser.page.locator('input[type="checkbox"]').first().check();
            await browser.delay(500, 1000);

            // Submit
            await browser.page.locator('button:has-text("Continue")').first().click();
            await browser.delay(3000, 5000);

            // Handle captcha
            const hasCaptcha = await browser.page.locator('iframe[src*="hcaptcha"]').first().isVisible().catch(() => false);
            if (hasCaptcha) {
                const siteKey = await browser.page.evaluate(() => document.querySelector('[data-sitekey]')?.dataset.sitekey || 'a9b5fb07-92ff-493f-86fe-352a2803b3df');
                const solution = await this.solver.solve('https://discord.com/register', siteKey, proxy);
                
                await browser.page.evaluate((tok) => {
                    document.querySelectorAll('textarea').forEach(ta => {
                        if (ta.name.includes('h-captcha')) {
                            ta.value = tok;
                            ta.dispatchEvent(new Event('input', { bubbles: true }));
                        }
                    });
                }, solution);
                
                await browser.delay(2000, 3000);
                await browser.page.locator('button:has-text("Continue")').first().click();
                await browser.delay(5000, 8000);
            }

            // Get token
            for (let i = 0; i < 15; i++) {
                token = await browser.page.evaluate(() => localStorage.getItem('token')?.replace(/"/g, ''));
                if (token) break;
                
                const url = browser.page.url();
                if (url.includes('/channels') || url.includes('/app')) {
                    token = await browser.page.evaluate(() => localStorage.getItem('token')?.replace(/"/g, ''));
                    break;
                }
                
                const err = await browser.page.locator('text=/rate limited|already registered/i').first().innerText().catch(() => null);
                if (err) throw new Error(err);
                
                await browser.delay(1000, 1500);
            }

            if (!token) throw new Error('No token');

            this.stats.success++;
            const account = { ...user, token, proxy: proxy.id, createdAt: new Date().toISOString() };
            
            await fs.appendFile('/tmp/accounts.txt', `${account.email}:${account.password}:${account.token}:${account.proxy}\n`);
            console.log(chalk.green.bold('  ✓ Success'));
            
            return account;

        } catch (err) {
            this.stats.failed++;
            console.log(chalk.red(`  ✗ ${err.message}`));
            throw err;
        } finally {
            await browser.close();
        }
    }

    printStats() {
        console.log(chalk.cyan.bold('\n=== STATS ==='));
        console.log(`Attempts: ${this.stats.attempts}`);
        console.log(chalk.green(`Success: ${this.stats.success}`));
        console.log(chalk.red(`Failed: ${this.stats.failed}`));
    }
}

module.exports = { Generator };
