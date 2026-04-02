const fs = require('fs-extra');
const chalk = require('chalk');
const { scrapeAndValidate, validateExisting } = require('./scraper');
const { Generator } = require('./generator');
const config = require('./config');

async function main() {
    console.log(chalk.green.bold('=== Discord Generator ===\n'));
    
    config.validate();
    
    // Check balance
    const { CaptchaSolver } = require('./captcha');
    const balance = await new CaptchaSolver().getBalance();
    console.log(chalk.blue(`Balance: $${balance}`));
    
    // Load proxies
    let proxies = [];
    try {
        proxies = await fs.readJson('/tmp/working_proxies.json');
        if (proxies.length < config.MIN_PROXIES) {
            console.log(chalk.yellow('Insufficient proxies, rescraping...'));
            proxies = await scrapeAndValidate();
        }
    } catch {
        proxies = await scrapeAndValidate();
    }
    
    console.log(chalk.blue(`Proxies: ${proxies.length}`));
    
    // Generate
    const gen = new Generator();
    let count = 0;
    
    for (const proxy of proxies) {
        if (count >= config.TARGET_COUNT) break;
        
        try {
            await gen.generate(proxy);
            count++;
            
            if (count < config.TARGET_COUNT) {
                await new Promise(r => setTimeout(r, Math.random() * 5000 + 5000));
            }
        } catch {
            continue;
        }
    }
    
    gen.printStats();
    process.exit(0);
}

main().catch(e => {
    console.error(chalk.red(e.message));
    process.exit(1);
});
