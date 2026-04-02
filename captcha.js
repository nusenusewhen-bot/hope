const axios = require('axios');
const chalk = require('chalk');

class CaptchaSolver {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.baseUrl = 'https://api.anti-captcha.com';
    }

    async getBalance() {
        try {
            const res = await axios.post(`${this.baseUrl}/getBalance`, {
                clientKey: this.apiKey
            });
            return res.data.balance;
        } catch {
            return 0;
        }
    }

    async solveHcaptcha(pageUrl, siteKey, proxy = null) {
        console.log(chalk.blue('[Captcha] Creating task...'));
        
        let taskPayload;
        
        if (proxy) {
            // Solve through same proxy
            const [ip, port] = proxy.id.split(':');
            taskPayload = {
                clientKey: this.apiKey,
                task: {
                    type: 'HCaptchaTask',
                    websiteURL: pageUrl,
                    websiteKey: siteKey,
                    proxyType: proxy.type === 'socks5' ? 'socks5' : 'http',
                    proxyAddress: ip,
                    proxyPort: parseInt(port),
                    proxyLogin: '',
                    proxyPassword: '',
                    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0'
                }
            };
        } else {
            // Fallback to proxyless (less effective)
            taskPayload = {
                clientKey: this.apiKey,
                task: {
                    type: 'HCaptchaTaskProxyless',
                    websiteURL: pageUrl,
                    websiteKey: siteKey
                }
            };
        }

        const createRes = await axios.post(`${this.baseUrl}/createTask`, taskPayload);
        
        if (createRes.data.errorId !== 0) {
            throw new Error(`AntiCaptcha: ${createRes.data.errorDescription}`);
        }

        const taskId = createRes.data.taskId;
        console.log(chalk.blue(`[Captcha] Task ID: ${taskId}`));
        
        // Poll for result
        for (let i = 0; i < 120; i++) {
            await new Promise(r => setTimeout(r, 5000));
            
            const result = await axios.post(`${this.baseUrl}/getTaskResult`, {
                clientKey: this.apiKey,
                taskId: taskId
            });

            if (result.data.status === 'ready') {
                console.log(chalk.green('[Captcha] Solution received'));
                return result.data.solution.gRecaptchaResponse;
            }
            
            process.stdout.write(chalk.gray(`\r[Captcha] Waiting... ${(i+1)*5}s`));
        }
        
        throw new Error('Captcha timeout');
    }
}

module.exports = { CaptchaSolver };
