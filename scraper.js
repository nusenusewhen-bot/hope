const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const fs = require('fs-extra');
const chalk = require('chalk');

const SOURCES = [
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

async function scrapeProxies() {
    console.log(chalk.blue('[Scraper] Fetching proxies...'));
    const proxies = new Set();
    
    await Promise.all(SOURCES.map(async (source) => {
        try {
            const res = await axios.get(source, { 
                timeout: 15000,
                headers: { 'User-Agent': 'Mozilla/5.0' }
            });
            const lines = res.data.split('\n')
                .map(l => l.trim())
                .filter(l => /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{2,5}$/.test(l));
            lines.forEach(l => proxies.add(l));
        } catch (e) {
            // Silent fail for individual sources
        }
    }));
    
    console.log(chalk.blue(`[Scraper] Found ${proxies.size} unique proxies`));
    return Array.from(proxies);
}

async function testProxy(proxyStr, type = 'http') {
    const [ip, port] = proxyStr.split(':');
    const proxyUrl = type === 'socks5' 
        ? `socks5://${ip}:${port}` 
        : `http://${ip}:${port}`;
    
    try {
        const agent = type === 'socks5' 
            ? new SocksProxyAgent(proxyUrl) 
            : new HttpsProxyAgent(proxyUrl);
        
        const start = Date.now();
        const res = await axios.get('https://discord.com/api/v9/gateway', {
            httpsAgent: agent,
            httpAgent: agent,
            timeout: 8000,
            validateStatus: () => true
        });
        
        const latency = Date.now() - start;
        
        if (res.status === 200 && res.data?.url && !res.data.url.includes('captcha')) {
            return { working: true, latency, type, ip, port: parseInt(port) };
        }
        return { working: false };
    } catch {
        return { working: false };
    }
}

async function validateProxies(proxyList, concurrency = 100) {
    console.log(chalk.yellow(`[Validator] Testing ${proxyList.length} proxies (${concurrency} threads)...`));
    
    const working = [];
    
    for (let i = 0; i < proxyList.length; i += concurrency) {
        const batch = proxyList.slice(i, i + concurrency);
        const results = await Promise.all(
            batch.map(async (proxy) => {
                let result = await testProxy(proxy, 'http');
                if (!result.working && ['1080', '1085', '4145', '9050'].includes(proxy.split(':')[1])) {
                    result = await testProxy(proxy, 'socks5');
                }
                return { proxy, ...result };
            })
        );
        
        results.forEach(r => {
            if (r.working) {
                working.push({
                    id: r.proxy,
                    ip: r.ip,
                    port: r.port,
                    type: r.type,
                    latency: r.latency,
                    lastUsed: 0,
                    failCount: 0
                });
            }
        });
        
        process.stdout.write(chalk.gray(`\r  Tested: ${Math.min(i + concurrency, proxyList.length)}/${proxyList.length} | Working: ${working.length}`));
    }
    
    console.log(chalk.green(`\n[Validator] ${working.length} working proxies`));
    
    working.sort((a, b) => a.latency - b.latency);
    
    // Ensure /tmp exists
    await fs.ensureDir('/tmp');
    await fs.writeJson('/tmp/working_proxies.json', working);
    
    return working;
}

async function scrapeAndValidate() {
    const proxies = await scrapeProxies();
    if (proxies.length === 0) {
        throw new Error('No proxies scraped from any source');
    }
    return await validateProxies(proxies, 150);
}

module.exports = { scrapeAndValidate };
