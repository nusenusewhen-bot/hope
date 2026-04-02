const fs = require('fs-extra');
const chalk = require('chalk');
const { StealthBrowser } = require('./browser');
const { CaptchaSolver } = require('./captcha');

class AccountGenerator {
    constructor(captchaKey) {
        this.captchaSolver = new CaptchaSolver(captchaKey);
        this.stats = { attempts: 0, success: 0, failed: 0, captchaSolved: 0 };
        this.accounts = [];
    }

    generateUsername() {
        const adjectives = ['Shadow', 'Silent', 'Dark', 'Ghost', 'Cyber', 'Neon', 'Phantom', 'Stealth', 'Night', 'Frost'];
        const nouns = ['Hunter', 'Wraith', 'Ninja', 'Coder', 'Spectre', 'Viper', 'Drift', 'Wolf', 'Raven', 'Storm'];
        const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
        const noun = nouns[Math.floor(Math.random() * nouns.length)];
        const num = Math.floor(Math.random() * 99999);
        return `${adj}${noun}${num}`;
    }

    generatePassword() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
        let pass = '';
        for (let i = 0; i < 16; i++) {
            pass += chars[Math.floor(Math.random() * chars.length)];
        }
        return pass;
    }

    generateDOB() {
        const months = ['January', 'February', 'March', 'April', 'May', 'June', 
                       'July', 'August', 'September', 'October', 'November', 'December'];
        return {
            month: months[Math.floor(Math.random() * 12)],
            day: Math.floor(Math.random() * 28 + 1).toString(),
            year: Math.floor(Math.random() * (2004 - 1990) + 1990).toString()
        };
    }

    async generateAccount(proxy) {
        this.stats.attempts++;
        const browser = new StealthBrowser(proxy);
        let token = null;

        try {
            console.log(chalk.blue(`\n[Gen] Starting with proxy ${proxy.id}`));
            
            await browser.launch();
            
            // Navigate to Discord register
            await browser.navigate('https://discord.com/register');
            
            // Check for immediate captcha (flagged IP)
            const hasCaptcha = await browser.page.locator('iframe[src*="hcaptcha"]').count() > 0;
            if (hasCaptcha) {
                console.log(chalk.yellow('[Gen] Proxy flagged (captcha on load)'));
                throw new Error('Flagged IP');
            }

            // Generate account data
            const username = this.generateUsername();
            const email = `${username.toLowerCase()}${Math.floor(Math.random()*9999)}@gmail.com`;
            const password = this.generatePassword();
            const dob = this.generateDOB();

            console.log(chalk.gray(`  Email: ${email}`));
            console.log(chalk.gray(`  User: ${username}`));

            // Fill form with human behavior
            await browser.typeHuman('input[type="email"]', email);
            await browser.typeHuman('input[name="username"]', username);
            await browser.typeHuman('input[type="password"]', password);
            
            // Date of birth
            await browser.selectDropdown(0, dob.month);
            await browser.selectDropdown(1, dob.day);
            await browser.selectDropdown(2, dob.year);

            // Check TOS
            await browser.page.locator('input[type="checkbox"]').first().check();
            await browser.humanDelay(500, 1000);

            // Submit
            console.log(chalk.blue('[Gen] Submitting...'));
            await browser.page.locator('button:has-text("Continue")').first().click();
            await browser.humanDelay(3000, 5000);

            // Check for captcha
            const captchaFrame = await browser.page.locator('iframe[src*="hcaptcha"]').first();
            const needsCaptcha = await captchaFrame.isVisible().catch(() => false);
            
            if (needsCaptcha) {
                console.log(chalk.yellow('[Gen] Solving captcha...'));
                
                const siteKey = await browser.page.evaluate(() => {
                    return document.querySelector('[data-sitekey]')?.dataset.sitekey 
                        || 'a9b5fb07-92ff-493f-86fe-352a2803b3df';
                });

                const solution = await this.captchaSolver.solveHcaptcha(
                    'https://discord.com/register',
                    siteKey,
                    proxy
                );
                
                this.stats.captchaSolved++;

                // Inject solution
                await browser.page.evaluate((token) => {
                    document.querySelectorAll('textarea').forEach(ta => {
                        if (ta.name.includes('h-captcha') || ta.id.includes('h-captcha')) {
                            ta.value = token;
                            ta.dispatchEvent(new Event('input', { bubbles: true }));
                        }
                    });
                }, solution);

                await browser.humanDelay(2000, 3000);
                
                // Re-submit
                await browser.page.locator('button:has-text("Continue")').first().click();
                await browser.humanDelay(5000, 8000);
            }

            // Wait for token
            for (let i = 0; i < 15; i++) {
                // Try to get token from localStorage
                token = await browser.page.evaluate(() => {
                    return localStorage.getItem('token')?.replace(/"/g, '');
                });
                
                if (token) break;

                // Check URL for success
                const url = browser.page.url();
                if (url.includes('/channels') || url.includes('/app')) {
                    token = await browser.page.evaluate(() => {
                        return localStorage.getItem('token')?.replace(/"/g, '');
                    });
                    break;
                }

                // Check for errors
                const errorText = await browser.page.locator('text=/rate limited|already registered|invalid/i').first().innerText().catch(() => null);
                if (errorText) {
                    throw new Error(errorText);
                }

                await browser.humanDelay(1000, 2000);
            }

            if (!token) {
                throw new Error('No token captured');
            }

            // Success
            this.stats.success++;
            const account = {
                email,
                password,
                username,
                token,
                proxy: proxy.id,
                createdAt: new Date().toISOString()
            };
            
            this.accounts.push(account);
            await this.saveAccount(account);
            
            console.log(chalk.green.bold('  ✓ Account created successfully!'));
            
            return account;

        } catch (err) {
            this.stats.failed++;
            console.log(chalk.red(`  ✗ Failed: ${err.message}`));
            throw err;
        } finally {
            await browser.close();
        }
    }

    async saveAccount(account) {
        const line = `${account.email}:${account.password}:${account.token}:${account.proxy}\n`;
        await fs.appendFile('accounts.txt', line);
    }

    printStats() {
        console.log(chalk.cyan.bold('\n╔════════════════════════════════════════╗'));
        console.log(chalk.cyan.bold('║           GENERATION STATS             ║'));
        console.log(chalk.cyan.bold('╠════════════════════════════════════════╣'));
        console.log(chalk.white(`║  Attempts:      ${this.stats.attempts.toString().padEnd(23)}║`));
        console.log(chalk.green(`║  Successful:    ${this.stats.success.toString().padEnd(23)}║`));
        console.log(chalk.red(`║  Failed:        ${this.stats.failed.toString().padEnd(23)}║`));
        console.log(chalk.yellow(`║  Captchas:      ${this.stats.captchaSolved.toString().padEnd(23)}║`));
        console.log(chalk.cyan.bold('╚════════════════════════════════════════╝'));
    }
}

module.exports = { AccountGenerator };
