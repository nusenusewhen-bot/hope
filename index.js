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
    
    // Load or scrape proxies - AUTO-SCRAPE IF NONE
    let proxies = [];
    try {
        proxies = await fs.readJson('/tmp/working_proxies.json');
        console.log(chalk.blue(`Loaded ${proxies.length} cached proxies`));
        
        if (proxies.length < config.MIN_PROXIES) {
            console.log(chalk.yellow('Insufficient cached proxies, rescraping...'));
            throw new Error('Need fresh proxies');
        }
    } catch {
        console.log(chalk.yellow('No valid proxy cache found. Running scraper...'));
        proxies = await scrapeAndValidate();
    }
    
    if (proxies.length === 0) {
        console.log(chalk.red('No working proxies found after scraping'));
        process.exit(1);
    }
    
    console.log(chalk.green(`Ready with ${proxies.length} proxies`));
    
    // Generate
    const gen = new Generator();
    let count = 0;
    let proxyIndex = 0;
    
    while (count < config.TARGET_COUNT && proxyIndex < proxies.length) {
        const proxy = proxies[proxyIndex++];
        
        try {
            await gen.generate(proxy);
            count++;
            
            if (count < config.TARGET_COUNT) {
                const delay = Math.random() * 5000 + 5000;
                console.log(chalk.gray(`Waiting ${Math.round(delay)}ms...`));
                await new Promise(r => setTimeout(r, delay));
            }
        } catch (err) {
            console.log(chalk.yellow(`Proxy failed, trying next...`));
            continue;
        }
    }
    
    gen.printStats();
    
    if (count === 0) {
        console.log(chalk.red('No accounts generated. All proxies failed.'));
        process.exit(1);
    }
    
    console.log(chalk.green(`Done! Generated ${count}/${config.TARGET_COUNT} accounts`));
    process.exit(0);
}

main().catch(e => {
    console.error(chalk.red(e.message));
    process.exit(1);
});
