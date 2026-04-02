const axios = require('axios');
const chalk = require('chalk');
const config = require('./config');

class CaptchaSolver {
    constructor() {
        this.key = config.ANTICAPTCHA_KEY;
        this.baseUrl = 'https://api.anti-captcha.com';
    }

    async getBalance() {
        try {
            const res = await axios.post(`${this.baseUrl}/getBalance`, {
                clientKey: this.key
            });
            return res.data.balance;
        } catch {
            return 0;
        }
    }

    async solve(pageUrl, siteKey, proxy = null) {
        console.log(chalk.blue('[Captcha] Creating task...'));
        
        const task = proxy ? {
            type: 'HCaptchaTask',
            websiteURL: pageUrl,
            websiteKey: siteKey,
            proxyType: proxy.type === 'socks5' ? 'socks5' : 'http',
            proxyAddress: proxy.ip,
            proxyPort: proxy.port,
            proxyLogin: '',
            proxyPassword: '',
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0'
        } : {
            type: 'HCaptchaTaskProxyless',
            websiteURL: pageUrl,
            websiteKey: siteKey
        };

        const create = await axios.post(`${this.baseUrl}/createTask`, {
            clientKey: this.key,
            task
        });

        if (create.data.errorId !== 0) {
            throw new Error(create.data.errorDescription);
        }

        const taskId = create.data.taskId;
        
        for (let i = 0; i < 120; i++) {
            await new Promise(r => setTimeout(r, 5000));
            
            const result = await axios.post(`${this.baseUrl}/getTaskResult`, {
                clientKey: this.key,
                taskId
            });

            if (result.data.status === 'ready') {
                console.log(chalk.green('[Captcha] Solved'));
                return result.data.solution.gRecaptchaResponse;
            }
            
            process.stdout.write(chalk.gray(`\r[Captcha] ${(i+1)*5}s`));
        }
        
        throw new Error('Timeout');
    }
}

module.exports = { CaptchaSolver };
