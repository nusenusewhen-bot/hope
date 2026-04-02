const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const fs = require('fs').promises;
const chalk = require('chalk');
const ProxyAgent = require('proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { spawn } = require('child_process');

puppeteer.use(StealthPlugin());

// ============================================
// PROXY ROTATOR & GENERATOR SYSTEM
// ============================================

class ProxyRotator {
    constructor() {
        this.proxies = [];
        this.workingProxies = new Map(); // proxy -> { working: boolean, latency: number, lastUsed: timestamp, failCount: number }
        this.currentIndex = 0;
        this.rotationStrategy = 'round-robin'; // 'round-robin', 'random', 'weighted', 'least-recently-used'
        this.maxFailures = 3;
        this.cooldownPeriod = 300000; // 5 minutes cooldown for failed proxies
        this.testUrl = 'https://discord.com/api/v9/gateway';
        this.concurrentTests = 10;
        this.loadProxiesFromPastebin();
    }

    // Load proxies from your pastebin list
    async loadProxiesFromPastebin() {
        // Your proxy list from pastebin
        const proxyList = [
            "206.123.156.229:10525", "98.175.31.195:4145", "206.123.156.201:34722",
            "174.77.111.196:4145", "206.123.156.224:4293", "206.123.156.181:5890",
            "206.123.156.208:5935", "206.123.156.226:4526", "170.64.170.204:1080",
            "72.223.188.67:4145", "206.123.156.215:6634", "206.123.156.225:14164",
            "206.123.156.212:5400", "206.123.156.184:13058", "72.214.108.67:4145",
            "206.123.156.189:4521", "206.123.156.206:6692", "206.123.156.179:5344",
            "206.123.156.227:6852", "174.75.211.222:4145", "206.123.156.202:4545",
            "206.123.156.186:4649", "206.123.156.203:8967", "206.123.156.221:4357",
            "206.123.156.191:12974", "206.123.156.223:6495", "206.123.156.183:9114",
            "206.123.156.231:9765", "206.123.156.192:4463", "206.123.156.195:7825",
            "167.103.144.127:8800", "167.103.31.122:8800", "94.130.16.48:30103",
            "192.104.242.158:4145", "74.119.144.60:4145", "206.123.156.209:19976",
            "68.1.210.189:4145", "206.123.156.233:23733", "206.123.156.177:5719",
            "195.200.166.126:443", "196.21.61.67:443", "72.207.109.5:4145",
            "47.238.205.249:1011", "52.178.94.61:443", "158.173.154.74:9002",
            "158.173.154.52:9002", "84.239.49.154:9002", "84.239.49.186:9002",
            "193.226.205.54:443", "51.158.202.56:443", "51.159.225.196:23856",
            "52.233.143.240:443", "128.93.193.2:8443", "50.7.176.123:443",
            "185.219.159.41:443", "185.219.159.19:443", "185.219.159.40:443",
            "84.239.49.41:9002", "84.239.49.42:9002", "84.239.49.37:9002",
            "84.239.49.51:9002", "84.239.49.220:9002", "216.68.128.121:4145",
            "84.239.49.54:9002", "193.176.84.38:9002", "84.239.14.148:9002",
            "84.239.14.166:9002", "156.146.59.39:9002", "84.239.49.200:9002",
            "193.176.84.35:9002", "84.239.49.227:9002", "84.239.49.45:9002",
            "84.239.14.167:9002", "156.146.59.11:9002", "156.146.59.10:9002",
            "89.124.11.12:443", "84.239.49.47:9002", "84.239.49.176:9002",
            "138.199.35.201:9002", "89.111.27.221:443", "37.203.37.83:443",
            "165.22.60.108:443", "184.178.172.28:15294", "84.239.49.254:9002",
            "146.177.5.114:8090", "184.181.217.210:4145", "203.246.113.240:443",
            "129.150.55.165:1080", "103.75.118.84:1080", "84.239.49.219:9002",
            "158.173.154.65:9002", "184.178.172.3:4145", "37.203.37.171:443",
            "84.239.49.160:9002", "158.173.154.49:9002", "147.161.239.240:8800",
            "65.109.40.163:8443", "167.103.115.102:8800", "93.180.217.254:443",
            "208.65.90.3:4145", "84.239.49.178:9002", "158.173.154.75:9002",
            "184.181.217.213:4145", "156.146.59.36:9002", "84.17.47.150:9002",
            "158.173.154.47:9002", "45.56.228.8:443", "84.72.72.153:443",
            "89.234.183.82:443", "89.105.200.65:443", "130.230.140.220:443",
            "84.239.14.153:9002", "84.239.49.211:9002", "208.65.90.21:4145",
            "84.239.49.185:9002", "84.239.49.197:9002", "193.176.84.16:9002",
            "84.239.49.55:9002", "185.219.159.39:443", "4.213.225.50:443",
            "168.138.159.191:443", "156.146.59.46:9002", "84.239.14.165:9002",
            "196.21.109.82:443", "84.239.49.180:9002", "138.199.35.199:9002",
            "185.219.159.28:443", "41.205.129.179:443", "37.203.37.190:443",
            "156.146.59.15:9002", "150.136.9.146:443", "138.199.35.197:9002",
            "167.103.34.108:8800", "158.173.154.80:9002", "134.0.63.185:443",
            "133.242.152.27:443", "84.239.49.205:9002", "84.239.49.60:9002",
            "178.237.108.214:443", "74.208.228.10:443", "37.203.37.108:443",
            "206.123.156.197:9902", "194.249.231.22:443", "84.239.14.149:9002",
            "193.176.84.34:9002", "156.146.59.33:9002", "84.239.49.173:9002",
            "84.239.49.206:9002", "116.106.106.79:1080", "84.239.49.198:9002",
            "158.173.154.78:9002", "203.126.53.78:443", "46.229.243.220:443",
            "84.17.47.147:9002", "195.154.187.64:443", "20.103.207.25:443",
            "193.176.84.36:9002", "138.199.35.205:9002", "185.219.159.26:443",
            "217.217.249.160:8080", "45.90.32.134:3128", "89.111.28.77:443",
            "51.158.252.149:16684", "185.245.136.61:443", "84.239.49.169:9002",
            "138.199.35.198:9002", "138.199.35.206:9002", "52.157.156.231:443",
            "84.239.49.161:9002", "84.239.49.250:9002", "88.197.53.165:443",
            "84.239.49.229:9002", "31.192.106.135:8010", "37.203.37.102:443",
            "158.173.154.62:9002", "37.203.37.100:443", "84.239.49.57:9002",
            "181.191.209.142:443", "193.77.81.97:443", "193.176.84.19:9002",
            "193.176.84.37:9002", "38.60.209.79:20002", "156.146.59.42:9002",
            "84.239.49.248:9002", "160.242.47.197:443", "23.106.249.54:6550",
            "84.239.49.158:9002", "181.126.49.38:443", "83.103.36.213:443",
            "13.125.141.135:443", "138.199.35.216:9002", "158.173.154.70:9002",
            "80.97.226.98:443", "84.239.14.156:9002", "89.111.27.219:443",
            "176.102.64.4:443", "206.123.156.244:11013", "156.146.59.40:9002",
            "84.239.14.150:9002", "158.173.154.76:9002", "84.239.49.243:9002",
            "51.159.226.126:16684", "212.243.240.120:443", "193.137.38.135:443",
            "156.146.59.37:9002", "152.71.251.13:443", "138.199.35.200:9002",
            "84.239.49.213:9002", "84.239.49.62:9002", "69.61.200.104:36181",
            "138.199.35.214:9002", "84.239.14.157:9002", "89.111.31.245:443",
            "84.239.49.40:9002", "203.193.169.112:443", "89.124.11.10:443",
            "156.146.59.17:9002", "84.239.49.239:9002", "72.49.49.11:31034",
            "193.176.84.24:9002", "147.45.240.36:1080", "200.174.198.32:8888",
            "158.173.154.46:9002", "185.219.159.36:443", "193.176.84.33:9002",
            "84.239.49.238:9002", "84.239.49.201:9002", "84.239.14.164:9002",
            "156.146.59.35:9002", "23.106.56.43:19881", "156.146.59.13:9002",
            "88.135.143.159:443", "160.250.54.5:9000", "82.64.46.151:443",
            "162.247.78.194:443", "208.102.51.6:58208", "156.146.59.25:9002",
            "185.219.159.17:443", "84.239.49.177:9002", "156.146.59.14:9002",
            "84.239.49.251:9002", "158.195.68.53:443", "89.111.27.217:443",
            "5.255.117.127:1080", "89.111.30.182:443", "138.199.35.209:9002",
            "185.219.159.29:443", "84.239.49.192:9002", "158.173.154.54:9002",
            "159.203.22.247:443", "84.239.14.172:9002", "146.189.216.138:443",
            "185.219.159.24:443", "158.173.154.81:9002", "158.173.154.77:9002",
            "138.199.35.195:9002", "198.177.253.13:4145", "16.78.119.130:443",
            "84.239.14.168:9002", "194.195.87.167:8080", "193.176.84.29:9002",
            "84.239.49.156:9002", "84.239.49.218:9002", "158.173.154.83:9002",
            "138.199.35.219:9002", "195.123.211.248:443", "173.249.5.133:1080",
            "84.239.49.225:9002", "84.239.14.155:9002", "89.124.11.13:443",
            "185.219.159.37:443", "158.173.154.68:9002", "154.64.235.206:58367",
            "84.239.49.215:9002", "84.239.49.175:9002", "84.239.49.208:9002",
            "37.203.37.188:443", "84.239.49.207:9002", "158.173.154.73:9002",
            "198.177.254.157:4145", "89.33.44.23:443", "189.50.88.34:443",
            "84.239.49.240:9002", "134.1.7.9:443", "20.78.213.56:443",
            "89.124.11.9:443", "193.176.84.22:9002", "84.239.14.154:9002",
            "84.239.49.214:9002", "84.239.49.58:9002", "95.217.233.255:443",
            "156.146.59.18:9002", "84.239.49.38:9002", "185.219.159.33:443",
            "84.239.49.189:9002", "84.239.49.49:9002", "84.239.49.194:9002",
            "156.146.59.32:9002", "195.181.220.235:443", "193.176.84.23:9002",
            "84.239.49.246:9002", "51.159.70.244:443", "84.17.47.126:9002",
            "158.173.154.82:9002", "84.239.49.56:9002", "51.158.194.16:14287",
            "34.93.103.38:443", "84.239.49.184:9002", "35.187.237.178:443",
            "158.173.154.50:9002", "4.188.2.252:443", "46.229.243.211:443",
            "156.146.59.38:9002", "84.239.49.247:9002", "147.161.179.21:10810",
            "37.203.37.88:443", "158.173.154.79:9002", "156.146.59.27:9002",
            "84.239.49.191:9002", "138.199.35.203:9002", "138.199.35.215:9002",
            "158.173.154.85:9002", "23.106.249.52:2569", "84.239.49.253:9002",
            "84.239.14.169:9002", "185.219.159.25:443", "185.219.159.16:443",
            "46.105.160.186:1080", "84.239.49.46:9002", "158.173.154.63:9002",
            "84.239.49.242:9002", "193.176.84.30:9002", "156.146.59.20:9002",
            "80.77.112.216:443", "156.146.59.9:9002", "195.192.209.130:9443",
            "84.239.49.168:9002", "87.238.253.66:443", "84.239.49.212:9002",
            "158.173.154.48:9002", "104.218.50.155:443", "20.235.106.55:443",
            "84.239.49.210:9002", "178.115.238.253:443", "138.199.35.212:9002",
            "84.239.49.171:9002", "84.239.49.217:9002", "37.203.37.81:443",
            "84.239.49.159:9002", "173.249.37.45:5051", "193.176.84.21:9002",
            "84.239.49.170:9002", "23.106.249.34:21125", "193.176.84.39:9002",
            "74.50.65.152:1080", "84.239.49.230:9002", "158.173.154.51:9002",
            "138.199.35.218:9002", "192.95.37.111:443", "84.17.47.123:9002",
            "156.146.59.34:9002", "147.161.210.140:8800", "193.176.84.40:9002",
            "84.239.49.203:9002", "84.239.49.162:9002", "138.199.35.202:9002",
            "84.239.49.61:9002", "156.146.59.28:9002", "156.146.59.5:9002",
            "156.146.59.43:9002", "156.146.59.44:9002", "104.219.236.127:1080",
            "31.31.78.117:443", "158.173.154.4:9002", "84.239.49.187:9002",
            "84.17.47.148:9002", "84.17.47.146:9002", "89.111.30.87:443",
            "158.173.154.55:9002", "185.219.159.20:443", "138.199.35.217:9002",
            "148.233.136.213:443", "185.219.159.35:443", "84.239.14.175:9002",
            "198.177.252.24:4145", "84.239.49.228:9002", "185.245.136.97:443",
            "84.239.49.223:9002", "193.176.84.20:9002", "185.219.157.127:443",
            "89.111.30.252:443", "138.199.35.204:9002", "84.239.49.209:9002",
            "185.219.159.31:443", "3.109.65.43:443", "156.146.59.47:9002",
            "51.158.194.107:14287", "104.200.152.30:4145", "35.247.136.78:443",
            "134.209.15.92:443", "84.239.14.151:9002", "84.239.14.162:9002",
            "193.176.84.17:9002", "84.239.49.249:9002", "84.239.49.236:9002",
            "118.163.99.115:443", "84.239.14.163:9002", "185.219.159.22:443",
            "156.146.59.7:9002", "156.146.59.29:9002", "84.239.49.44:9002",
            "156.146.59.30:9002", "37.203.37.99:443", "89.111.30.89:443",
            "84.239.49.188:9002", "84.239.49.53:9002", "89.124.11.6:443",
            "89.111.27.218:443", "158.173.154.67:9002", "161.35.227.149:443",
            "200.201.213.69:1088", "84.239.49.245:9002", "84.239.49.204:9002",
            "185.219.159.21:443", "54.37.72.89:443", "156.146.59.21:9002",
            "84.239.14.171:9002", "84.239.49.193:9002", "138.199.35.207:9002",
            "84.239.49.244:9002", "194.163.167.32:1080", "156.146.59.45:9002",
            "138.199.35.196:9002", "208.87.243.199:7878", "51.91.251.117:443",
            "45.119.97.69:443", "93.115.26.111:443", "156.146.59.22:9002",
            "84.239.49.233:9002", "84.239.49.226:9002", "151.115.78.51:443",
            "185.219.159.18:443", "157.90.167.183:443", "84.239.14.176:9002",
            "84.239.14.152:9002", "51.83.77.59:443", "84.17.47.125:9002",
            "83.13.36.250:443", "128.199.207.200:443", "84.17.47.124:9002",
            "84.239.14.170:9002", "158.173.154.66:9002", "84.239.49.190:9002",
            "156.146.59.23:9002", "193.176.84.25:9002", "195.14.103.106:9090",
            "200.133.218.122:443", "149.210.158.107:5001", "158.173.154.84:9002",
            "95.253.143.236:443", "156.146.59.12:9002", "84.239.49.224:9002",
            "84.239.14.174:9002", "193.176.84.27:9002", "84.239.49.157:9002",
            "158.173.154.71:9002", "185.219.159.23:443", "84.239.49.179:9002",
            "158.173.154.60:9002", "84.239.14.158:9002", "193.136.192.57:443",
            "129.97.50.72:443", "158.173.154.58:9002", "84.239.49.221:9002",
            "138.199.35.210:9002", "156.146.59.3:9002", "84.239.49.241:9002",
            "84.239.49.234:9002", "158.173.154.69:9002", "156.146.59.31:9002",
            "209.126.84.232:8888", "164.160.68.11:443", "85.158.220.164:443",
            "185.219.159.38:443", "84.239.49.235:9002", "84.239.14.147:9002",
            "168.205.255.238:443", "156.146.59.24:9002", "51.159.225.197:19362",
            "23.106.56.52:15767", "84.239.49.196:9002", "84.239.49.181:9002",
            "185.219.159.15:443", "198.177.254.131:4145", "37.203.37.80:443",
            "193.176.84.32:9002", "190.113.112.147:4443", "147.160.161.12:8081",
            "161.35.159.29:443", "84.17.47.149:9002", "84.239.49.50:9002",
            "156.244.2.102:20002", "37.203.37.187:443", "173.212.253.71:443",
            "51.158.204.46:21384", "213.241.124.228:443", "74.208.84.191:443",
            "84.239.14.146:9002", "156.146.59.16:9002", "212.58.132.5:1080",
            "156.146.59.6:9002", "159.223.53.194:1080", "185.219.159.34:443",
            "81.171.24.164:443", "185.219.157.125:443", "209.63.239.148:443",
            "1.231.81.166:3128", "84.239.49.231:9002", "84.239.49.252:9002",
            "164.160.68.42:443", "84.239.49.183:9002", "89.124.11.7:443",
            "23.106.56.35:16927", "185.219.159.27:443", "156.146.59.8:9002",
            "149.210.243.125:443", "203.25.108.77:443", "156.146.59.19:9002",
            "84.239.14.160:9002", "84.239.49.163:9002", "158.173.154.61:9002",
            "84.239.49.165:9002", "84.239.49.232:9002", "138.197.69.103:443",
            "156.146.59.41:9002", "79.139.56.178:443", "23.106.56.19:7579",
            "84.239.14.159:9002", "84.239.49.39:9002", "84.239.49.43:9002",
            "84.239.49.164:9002", "134.199.159.23:1080", "156.146.59.50:9002",
            "84.239.49.155:9002", "66.42.59.155:443", "84.239.49.167:9002",
            "52.140.7.131:443", "23.106.56.54:6157", "89.111.30.251:443",
            "84.239.14.173:9002", "147.182.255.208:443", "84.239.49.182:9002",
            "158.173.154.53:9002", "184.168.123.21:443", "193.176.84.31:9002",
            "157.245.96.148:443", "168.110.52.228:3128", "89.124.11.8:443",
            "138.199.35.211:9002", "23.106.56.11:7714", "156.146.59.2:9002",
            "156.146.59.48:9002", "156.146.59.49:9002", "193.176.84.18:9002",
            "193.176.84.26:9002", "37.203.37.105:443", "84.239.49.222:9002",
            "84.239.49.59:9002", "138.199.35.208:9002", "84.239.49.48:9002",
            "37.18.73.60:5566", "89.111.30.250:443", "84.239.49.199:9002",
            "158.173.154.72:9002", "84.239.49.172:9002", "185.219.157.126:443",
            "89.124.11.11:443", "158.173.154.57:9002", "158.173.154.56:9002",
            "84.239.49.166:9002", "89.111.31.105:443", "164.152.45.253:443",
            "177.234.217.88:999"
        ];

        // Parse and categorize proxies by type
        this.proxies = proxyList.map(addr => {
            const [ip, port] = addr.split(':');
            // Determine proxy type based on common ports
            let type = 'http';
            if (port === '4145' || port === '1080' || port === '1085') type = 'socks5';
            else if (port === '1081' || port === '1084') type = 'socks4';
            else if (port === '443' || port === '8443') type = 'https';
            
            return {
                id: `${ip}:${port}`,
                ip,
                port: parseInt(port),
                type,
                url: `${type}://${ip}:${port}`,
                httpUrl: `http://${ip}:${port}`,
                httpsUrl: `https://${ip}:${port}`,
                socksUrl: `socks5://${ip}:${port}`
            };
        });

        console.log(chalk.blue(`[ProxyRotator] Loaded ${this.proxies.length} proxies`));
        console.log(chalk.blue(`[ProxyRotator] Types: HTTP=${this.proxies.filter(p => p.type === 'http').length}, HTTPS=${this.proxies.filter(p => p.type === 'https').length}, SOCKS5=${this.proxies.filter(p => p.type === 'socks5').length}`));
        
        // Initial health check
        this.runHealthCheck();
    }

    async runHealthCheck() {
        console.log(chalk.yellow(`[ProxyRotator] Running initial health check on ${this.concurrentTests} threads...`));
        
        const batchSize = this.concurrentTests;
        const batches = [];
        
        for (let i = 0; i < this.proxies.length; i += batchSize) {
            batches.push(this.proxies.slice(i, i + batchSize));
        }

        for (const batch of batches) {
            await Promise.all(batch.map(proxy => this.testProxy(proxy)));
        }

        const working = Array.from(this.workingProxies.values()).filter(p => p.working).length;
        console.log(chalk.green(`[ProxyRotator] Health check complete: ${working}/${this.proxies.length} proxies working`));
    }

    async testProxy(proxy) {
        const startTime = Date.now();
        try {
            const agent = proxy.type === 'socks5' 
                ? new ProxyAgent(proxy.socksUrl)
                : new HttpsProxyAgent(proxy.httpUrl);

            const response = await axios.get(this.testUrl, {
                httpsAgent: agent,
                httpAgent: agent,
                timeout: 10000,
                validateStatus: () => true
            });

            const latency = Date.now() - startTime;
            const isWorking = response.status === 200;
            
            // Check if Discord flags this IP
            const isFlagged = response.data && typeof response.data === 'object' && response.data.url && response.data.url.includes('captcha');
            
            this.workingProxies.set(proxy.id, {
                ...proxy,
                working: isWorking && !isFlagged,
                latency,
                lastUsed: 0,
                failCount: 0,
                flagged: isFlagged,
                lastChecked: Date.now()
            });

            if (isWorking && !isFlagged) {
                console.log(chalk.green(`[ProxyTest] ✓ ${proxy.id} (${latency}ms)`));
            } else if (isFlagged) {
                console.log(chalk.red(`[ProxyTest] ⚠ FLAGGED ${proxy.id}`));
            }
            
            return isWorking && !isFlagged;
        } catch (err) {
            this.workingProxies.set(proxy.id, {
                ...proxy,
                working: false,
                latency: Infinity,
                failCount: (this.workingProxies.get(proxy.id)?.failCount || 0) + 1,
                lastChecked: Date.now()
            });
            return false;
        }
    }

    getNextProxy() {
        const working = Array.from(this.workingProxies.values()).filter(p => p.working);
        
        if (working.length === 0) {
            console.log(chalk.red(`[ProxyRotator] No working proxies! Retrying health check...`));
            this.runHealthCheck();
            return null;
        }

        let selected;

        switch (this.rotationStrategy) {
            case 'random':
                selected = working[Math.floor(Math.random() * working.length)];
                break;
            case 'weighted':
                // Prefer lower latency proxies
                const sorted = working.sort((a, b) => a.latency - b.latency);
                const weights = sorted.map((_, i) => 1 / (i + 1));
                const totalWeight = weights.reduce((a, b) => a + b, 0);
                let random = Math.random() * totalWeight;
                for (let i = 0; i < sorted.length; i++) {
                    random -= weights[i];
                    if (random <= 0) {
                        selected = sorted[i];
                        break;
                    }
                }
                selected = selected || sorted[0];
                break;
            case 'least-recently-used':
                selected = working.sort((a, b) => a.lastUsed - b.lastUsed)[0];
                break;
            case 'round-robin':
            default:
                this.currentIndex = (this.currentIndex + 1) % working.length;
                selected = working[this.currentIndex];
                break;
        }

        // Update last used
        const proxyData = this.workingProxies.get(selected.id);
        proxyData.lastUsed = Date.now();
        this.workingProxies.set(selected.id, proxyData);

        return selected;
    }

    async getWorkingProxy(maxRetries = 5) {
        for (let i = 0; i < maxRetries; i++) {
            const proxy = this.getNextProxy();
            if (!proxy) {
                await this.delay(2000);
                continue;
            }

            // Verify it's still working
            const isStillWorking = await this.testProxy(proxy);
            if (isStillWorking) {
                return proxy;
            }

            // Mark as failed
            const proxyData = this.workingProxies.get(proxy.id);
            proxyData.failCount++;
            if (proxyData.failCount >= this.maxFailures) {
                proxyData.working = false;
                console.log(chalk.yellow(`[ProxyRotator] ${proxy.id} failed ${this.maxFailures} times, disabling`));
            }
            this.workingProxies.set(proxy.id, proxyData);
        }
        
        throw new Error('No working proxies available after retries');
    }

    // Generate fresh proxy URL with session rotation for providers that support it
    generateSessionProxy(baseProxy, sessionId = null) {
        if (!sessionId) {
            sessionId = Math.random().toString(36).substring(2, 15);
        }
        
        // For Bright Data style proxies
        if (baseProxy.username && baseProxy.username.includes('brd-customer')) {
            return {
                ...baseProxy,
                username: `${baseProxy.username}-session-${sessionId}`
            };
        }
        
        return baseProxy;
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    getStats() {
        const all = Array.from(this.workingProxies.values());
        return {
            total: this.proxies.length,
            working: all.filter(p => p.working).length,
            failed: all.filter(p => !p.working).length,
            flagged: all.filter(p => p.flagged).length,
            avgLatency: all.filter(p => p.working).reduce((a, b) => a + b.latency, 0) / all.filter(p => p.working).length || 0
        };
    }
}

// ============================================
// ENHANCED DISCORD GENERATOR WITH PROXY ROTATION
// ============================================

const CONFIG = {
    antiCaptchaKey: process.env.ANTICAPTCHA_KEY || 'your-key-here',
    maxRetries: 10,
    retryDelay: 5000
};

class EnhancedDiscordGenerator {
    constructor() {
        this.proxyRotator = new ProxyRotator();
        this.captchaSolver = new AntiCaptchaSolver(CONFIG.antiCaptchaKey);
        this.metrics = { attempts: 0, success: 0, fail: 0, rateLimited: 0 };
        this.successfulAccounts = [];
    }

    async generate(count = 1) {
        console.log(chalk.green.bold(`[Generator] Starting batch of ${count} accounts...`));
        
        for (let i = 0; i < count; i++) {
            console.log(chalk.blue(`\n[Generator] --- Account ${i + 1}/${count} ---`));
            
            let attempts = 0;
            let success = false;
            
            while (attempts < CONFIG.maxRetries && !success) {
                attempts++;
                this.metrics.attempts++;
                
                try {
                    const result = await this.attemptRegistration();
                    this.metrics.success++;
                    this.successfulAccounts.push(result);
                    success = true;
                    
                    console.log(chalk.green.bold(`\n╔════════════════════════════════════════════════════════════╗`));
                    console.log(chalk.green.bold(`║       [✓✓✓] ACCOUNT ${i + 1} CREATED! [✓✓✓]              ║`));
                    console.log(chalk.green.bold(`╠════════════════════════════════════════════════════════════╣`));
                    console.log(chalk.green(`║  Email:    ${result.email.padEnd(45)}║`));
                    console.log(chalk.green(`║  Token:    ${result.token.slice(0, 40).padEnd(45)}║`));
                    console.log(chalk.green(`║  Proxy:    ${result.proxy.padEnd(45)}║`));
                    console.log(chalk.green.bold(`╚════════════════════════════════════════════════════════════╝\n`));
                    
                    // Save immediately
                    await this.saveAccount(result);
                    
                } catch (err) {
                    console.log(chalk.red(`[Attempt ${attempts}] Failed: ${err.message}`));
                    
                    if (err.message.includes('rate limit') || err.message.includes('flagged')) {
                        this.metrics.rateLimited++;
                    }
                    
                    if (attempts < CONFIG.maxRetries) {
                        const delay = CONFIG.retryDelay * attempts;
                        console.log(chalk.yellow(`[Retry] Waiting ${delay}ms before retry...`));
                        await this.delay(delay);
                    } else {
                        this.metrics.fail++;
                        console.log(chalk.red(`[Generator] Account ${i + 1} failed after ${CONFIG.maxRetries} attempts`));
                    }
                }
            }
            
            // Delay between accounts
            if (i < count - 1) {
                const interDelay = Math.floor(Math.random() * 5000) + 3000;
                console.log(chalk.blue(`[Generator] Waiting ${interDelay}ms before next account...`));
                await this.delay(interDelay);
            }
        }
        
        this.printFinalStats();
        return this.successfulAccounts;
    }

    async attemptRegistration() {
        // Get fresh working proxy
        const proxy = await this.proxyRotator.getWorkingProxy();
        console.log(chalk.blue(`[Proxy] Using ${proxy.id} (${proxy.type}, ${proxy.latency}ms)`));
        
        // Launch browser with proxy
        const browser = await this.launchBrowser(proxy);
        
        try {
            const page = await browser.newPage();
            
            // Set up request interception to capture token
            let capturedToken = null;
            page.on('response', async (response) => {
                if (response.url().includes('discord.com/api/v9/auth/register')) {
                    try {
                        const body = await response.json();
                        if (body.token) {
                            capturedToken = body.token;
                        }
                    } catch (e) {}
                }
            });
            
            // Navigate with retry logic
            await this.navigateWithRetry(page, 'https://discord.com/register');
            
            // Check for immediate captcha (flagged IP)
            const hasCaptcha = await page.$('iframe[src*="hcaptcha"]') !== null;
            if (hasCaptcha) {
                throw new Error('Flagged IP - captcha on load');
            }
            
            // Generate random account data
            const accountData = this.generateAccountData();
            console.log(chalk.blue(`[Form] Filling registration for ${accountData.email}`));
            
            // Fill form
            await this.fillRegistrationForm(page, accountData);
            
            // Submit and handle captcha if needed
            const token = await this.submitAndSolve(page, capturedToken);
            
            if (!token) {
                throw new Error('No token captured');
            }
            
            return {
                email: accountData.email,
                password: accountData.password,
                username: accountData.username,
                token: token,
                proxy: proxy.id,
                timestamp: new Date().toISOString()
            };
            
        } finally {
            await browser.close();
        }
    }

    async launchBrowser(proxy) {
        const args = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--window-size=1366,768',
            '--disable-extensions',
            '--disable-component-extensions-with-background-pages',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-features=TranslateUI,BlinkGenPropertyTrees',
            '--hide-scrollbars',
            '--mute-audio',
            `--proxy-server=${proxy.httpUrl}`
        ];

        // Additional stealth args
        if (proxy.type === 'socks5') {
            args.push(`--proxy-server=socks5://${proxy.ip}:${proxy.port}`);
        }

        return await puppeteer.launch({
            headless: 'new',
            args,
            ignoreHTTPSErrors: true
        });
    }

    async navigateWithRetry(page, url, maxRetries = 3) {
        for (let i = 0; i < maxRetries; i++) {
            try {
                await page.goto(url, { 
                    waitUntil: 'networkidle2',
                    timeout: 30000 
                });
                return;
            } catch (err) {
                if (i === maxRetries - 1) throw err;
                await this.delay(2000);
            }
        }
    }

    generateAccountData() {
        const adjectives = ['Shadow', 'Silent', 'Dark', 'Ghost', 'Cyber', 'Neon', 'Phantom', 'Stealth'];
        const nouns = ['Hunter', 'Wraith', 'Ninja', 'Coder', 'Spectre', 'Viper', 'Drift'];
        
        const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
        const noun = nouns[Math.floor(Math.random() * nouns.length)];
        const num = Math.floor(Math.random() * 99999);
        
        const username = `${adj}${noun}${num}`;
        const email = `${username.toLowerCase()}${num}@tempmail.com`;
        const password = this.generatePassword();
        
        const months = ['January', 'February', 'March', 'April', 'May', 'June', 
                       'July', 'August', 'September', 'October', 'November', 'December'];
        
        return {
            email,
            username,
            password,
            month: months[Math.floor(Math.random() * 12)],
            day: Math.floor(Math.random() * 28 + 1).toString(),
            year: Math.floor(Math.random() * (2004 - 1990) + 1990).toString()
        };
    }

    generatePassword() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
        let password = '';
        for (let i = 0; i < 16; i++) {
            password += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return password;
    }

    async fillRegistrationForm(page, data) {
        // Email
        await page.waitForSelector('input[type="email"]', { visible: true, timeout: 10000 });
        await page.type('input[type="email"]', data.email, { delay: 30 });
        await this.delay(300, 800);
        
        // Username
        await page.type('input[name="username"]', data.username, { delay: 40 });
        await this.delay(300, 800);
        
        // Password
        await page.type('input[type="password"]', data.password, { delay: 35 });
        await this.delay(300, 800);
        
        // Date of birth
        const dropdowns = await page.$$('div[role="button"][aria-haspopup="listbox"]');
        if (dropdowns.length >= 3) {
            // Month
            await dropdowns[0].click();
            await this.delay(300, 600);
            await page.evaluate((month) => {
                document.querySelectorAll('[role="option"]').forEach(opt => {
                    if (opt.textContent.trim() === month) opt.click();
                });
            }, data.month);
            await this.delay(300, 600);
            
            // Day
            await dropdowns[1].click();
            await this.delay(300, 600);
            await page.evaluate((day) => {
                document.querySelectorAll('[role="option"]').forEach(opt => {
                    if (opt.textContent.trim() === day) opt.click();
                });
            }, data.day);
            await this.delay(300, 600);
            
            // Year
            await dropdowns[2].click();
            await this.delay(300, 600);
            await page.evaluate((year) => {
                document.querySelectorAll('[role="option"]').forEach(opt => {
                    if (opt.textContent.trim() === year) opt.click();
                });
            }, data.year);
            await this.delay(500, 1000);
        }
        
        // Check TOS box if present
        await page.evaluate(() => {
            document.querySelectorAll('input[type="checkbox"]').forEach(cb => {
                if (!cb.checked && cb.isConnected) cb.click();
            });
        });
        
        await this.delay(500, 1000);
    }

    async submitAndSolve(page, preCapturedToken) {
        // Click submit
        await page.evaluate(() => {
            const btn = Array.from(document.querySelectorAll('button')).find(b => 
                b.textContent.toLowerCase().includes('continue') || 
                b.textContent.toLowerCase().includes('create account')
            );
            if (btn) {
                btn.scrollIntoView({ behavior: 'smooth' });
                btn.click();
            }
        });
        
        await this.delay(3000, 5000);
        
        // Check for captcha
        const hasCaptcha = await page.$('iframe[src*="hcaptcha"]') !== null;
        
        if (hasCaptcha) {
            console.log(chalk.yellow('[Captcha] Solving hCaptcha...'));
            
            const siteKey = await page.evaluate(() => {
                return document.querySelector('[data-sitekey]')?.getAttribute('data-sitekey') || 
                       'a9b5fb07-92ff-493f-86fe-352a2803b3df';
            });
            
            const solution = await this.captchaSolver.solveHcaptcha('https://discord.com/register', siteKey);
            
            // Inject solution
            await page.evaluate((token) => {
                document.querySelectorAll('textarea').forEach(ta => {
                    if (ta.name.includes('h-captcha') || ta.id.includes('h-captcha') || ta.getAttribute('data-hcaptcha-response') !== null) {
                        ta.value = token;
                        ta.setAttribute('data-hcaptcha-response', token);
                        ['input', 'change', 'blur'].forEach(evt => {
                            ta.dispatchEvent(new Event(evt, { bubbles: true }));
                        });
                    }
                });
                
                // Also try to find and trigger hCaptcha callback
                if (window.hcaptcha) {
                    window.hcaptcha.setResponse(token);
                }
            }, solution);
            
            await this.delay(2000, 3000);
            
            // Re-submit
            await page.evaluate(() => {
                const btn = Array.from(document.querySelectorAll('button')).find(b => 
                    b.textContent.toLowerCase().includes('continue') || 
                    b.textContent.toLowerCase().includes('create account')
                );
                if (btn) btn.click();
            });
            
            await this.delay(5000, 8000);
        }
        
        // Wait for token
        for (let i = 0; i < 20; i++) {
            if (preCapturedToken) return preCapturedToken;
            
            const token = await page.evaluate(() => {
                return window.localStorage?.getItem('token')?.replace(/"/g, '');
            });
            
            if (token) return token;
            
            // Check for errors
            const errorText = await page.evaluate(() => document.body.innerText);
            if (errorText.includes('rate limited')) {
                throw new Error('Rate limited');
            }
            if (errorText.includes('already registered')) {
                throw new Error('Email already registered');
            }
            
            await this.delay(1000, 2000);
        }
        
        return null;
    }

    async saveAccount(account) {
        const line = `${account.email}:${account.password}:${account.token}:${account.proxy}\n`;
        await fs.appendFile('accounts.txt', line);
    }

    printFinalStats() {
        console.log(chalk.cyan.bold(`\n╔════════════════════════════════════════════════════════════╗`));
        console.log(chalk.cyan.bold(`║                    FINAL STATISTICS                        ║`));
        console.log(chalk.cyan.bold(`╠════════════════════════════════════════════════════════════╣`));
        console.log(chalk.cyan(`║  Total Attempts:  ${this.metrics.attempts.toString().padEnd(39)}║`));
        console.log(chalk.green(`║  Successful:      ${this.metrics.success.toString().padEnd(39)}║`));
        console.log(chalk.red(`║  Failed:          ${this.metrics.fail.toString().padEnd(39)}║`));
        console.log(chalk.yellow(`║  Rate Limited:    ${this.metrics.rateLimited.toString().padEnd(39)}║`));
        console.log(chalk.cyan.bold(`╚════════════════════════════════════════════════════════════╝\n`));
        
        const proxyStats = this.proxyRotator.getStats();
        console.log(chalk.blue(`[Proxy Stats] Working: ${proxyStats.working}/${proxyStats.total}, Avg Latency: ${Math.round(proxyStats.avgLatency)}ms`));
    }

    delay(min, max) {
        if (typeof min === 'object') {
            return new Promise(r => setTimeout(r, Math.floor(Math.random() * (max - min) + min)));
        }
        return new Promise(r => setTimeout(r, min));
    }
}

// AntiCaptcha solver class (from your original code)
class AntiCaptchaSolver {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.baseUrl = 'https://api.anti-captcha.com';
    }

    async solveHcaptcha(pageUrl, siteKey) {
        console.log(chalk.blue(`[AntiCaptcha] Creating task...`));
        
        const createRes = await axios.post(`${this.baseUrl}/createTask`, {
            clientKey: this.apiKey,
            task: {
                type: 'HCaptchaTaskProxyless',
                websiteURL: pageUrl,
                websiteKey: siteKey
            }
        });

        if (createRes.data.errorId !== 0) {
            throw new Error(`AntiCaptcha error: ${createRes.data.errorDescription}`);
        }

        const taskId = createRes.data.taskId;
        
        for (let i = 0; i < 60; i++) {
            await new Promise(r => setTimeout(r, 5000));
            
            const result = await axios.post(`${this.baseUrl}/getTaskResult`, {
                clientKey: this.apiKey,
                taskId: taskId
            });

            if (result.data.status === 'ready') {
                console.log(chalk.green(`[AntiCaptcha] Solution received!`));
                return result.data.solution.gRecaptchaResponse;
            }
        }
        throw new Error('Captcha timeout');
    }
}

// Main execution
async function main() {
    console.log(chalk.green.bold(`
    ╔══════════════════════════════════════════════════════════════╗
    ║     ENHANCED DISCORD GENERATOR WITH PROXY ROTATION           ║
    ║     Auto-proxy rotation | Health checks | Smart retry        ║
    ╚══════════════════════════════════════════════════════════════╝
    `));
    
    const generator = new EnhancedDiscordGenerator();
    
    // Generate 5 accounts (change as needed)
    try {
        await generator.generate(5);
    } catch (err) {
        console.error(chalk.red(`[Fatal] ${err.message}`));
        process.exit(1);
    }
    
    process.exit(0);
}

if (require.main === module) {
    main().catch(err => {
        console.error(chalk.red(err));
        process.exit(1);
    });
}
