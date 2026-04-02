const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const fs = require('fs-extra');
const chalk = require('chalk');

class ProxyScraper {
    constructor() {
        this.sources = [
            'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=10000&country=all',
            'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all',
            'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt',
            'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
            'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt',
            'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
            'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/socks5.txt',
            'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt',
            'https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt',
            'https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/proxies.txt'
        ];
        this.workingProxies = [];
    }

    async scrapeAll() {
        console.log(chalk.blue('[Scraper] Fetching fresh proxies...'));
        const allProxies = new Set();
        
        for (const source of this.sources) {
            try {
                const response = await axios.get(source, { 
                    timeout: 20000,
                    headers: { 'User-Agent': 'Mozilla/5.0' }
                });
                const lines = response.data.split('\n')
                    .map(l => l.trim())
                    .filter(l => /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{2,5}$/.test(l));
                lines.forEach(l => allProxies.add(l));
                console.log(chalk.gray(`  ${source.split('/')[2]}: ${lines.length}`));
            } catch (err) {
                console.log(chalk.red(`  ✗ ${source.split('/')[2]}`));
            }
        }
        
        console.log(chalk.blue(`[Scraper] Total unique: ${allProxies.size}`));
        return Array.from(allProxies);
    }

    async testProxy(proxyStr, type = 'http') {
        const [ip, port] = proxyStr.split(':');
        const proxyUrl = type === 'socks5' ? `socks5://${ip}:${port}` : `http://${ip}:${port}`;
        
        try {
            const agent = type === 'socks5' 
                ? new SocksProxyAgent(proxyUrl) 
                : new HttpsProxyAgent(proxyUrl);
            
            const start = Date.now();
            
            // Test against Discord's actual API
            const response = await axios.get('https://discord.com/api/v9/gateway', {
                httpsAgent: agent,
                httpAgent: agent,
                timeout: 10000,
                validateStatus: () => true,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });
            
            const latency = Date.now() - start;
            
            // Check if response indicates clean IP
            if (response.status === 200 && response.data && response.data.url) {
                // Check for captcha indicator in response
                if (typeof response.data === 'object' && !response.data.url.includes('captcha')) {
                    return { 
                        working: true, 
                        latency, 
                        type,
                        id: proxyStr,
                        ip, 
                        port: parseInt(port),
                        lastUsed: 0,
                        failCount: 0
                    };
                }
            }
            
            return { working: false };
        } catch (err) {
            return { working: false, error: err.code };
        }
    }

    async validateAll(proxies, concurrency = 100) {
        console.log(chalk.yellow(`[Validator] Testing ${proxies.length} proxies (${concurrency} threads)...`));
        
        let tested = 0;
        let working = 0;
        
        // Test in batches
        for (let i = 0; i < proxies.length; i += concurrency) {
            const batch = proxies.slice(i, i + concurrency);
            
            const results = await Promise.all(
                batch.map(async (proxy) => {
                    // Try HTTP first
                    let result = await this.testProxy(proxy, 'http');
                    
                    // If HTTP fails and port suggests SOCKS, try SOCKS5
                    if (!result.working && ['1080', '1085', '4145'].includes(proxy.split(':')[1])) {
                        result = await this.testProxy(proxy, 'socks5');
                    }
                    
                    tested++;
                    return result;
                })
            );
            
            results.forEach(r => {
                if (r.working) {
                    this.workingProxies.push(r);
                    working++;
                }
            });
            
            process.stdout.write(chalk.gray(`\r  Progress: ${tested}/${proxies.length} | Working: ${working}`));
        }
        
        console.log(chalk.green(`\n[Validator] Found ${this.workingProxies.length} working proxies`));
        
        // Sort by latency
        this.workingProxies.sort((a, b) => a.latency - b.latency);
        
        // Save
        await fs.writeJson('working_proxies.json', this.workingProxies, { spaces: 2 });
        console.log(chalk.green(`[Validator] Saved to working_proxies.json`));
        
        return this.workingProxies;
    }
}

async function scrapeAndValidate() {
    const scraper = new ProxyScraper();
    const proxies = await scraper.scrapeAll();
    const working = await scraper.validateAll(proxies, 150);
    
    console.log(chalk.cyan('\n[Top 10 Fastest]'));
    working.slice(0, 10).forEach((p, i) => {
        console.log(chalk.white(`  ${i+1}. ${p.id} (${p.latency}ms) [${p.type}]`));
    });
    
    return working;
}

module.exports = { ProxyScraper, scrapeAndValidate };
