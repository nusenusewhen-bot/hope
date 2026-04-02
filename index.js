const fs = require('fs-extra');
const chalk = require('chalk');
const { AccountGenerator } = require('./generator');

async function main() {
    console.log(chalk.green.bold(`
    ╔══════════════════════════════════════════════════════════════╗
    ║     DISCORD ACCOUNT GENERATOR v3.0                           ║
    ║     Proxy Rotation | Stealth Browser | Captcha Solving       ║
    ╚══════════════════════════════════════════════════════════════╝
    `));

    // Load working proxies
    let proxies = [];
    try {
        proxies = await fs.readJson('working_proxies.json');
        console.log(chalk.blue(`[Main] Loaded ${proxies.length} validated proxies`));
    } catch {
        console.log(chalk.red('[Main] No working_proxies.json found. Run: npm run scrape'));
        process.exit(1);
    }

    if (proxies.length === 0) {
        console.log(chalk.red('[Main] No working proxies available'));
        process.exit(1);
    }

    const captchaKey = process.env.ANTICAPTCHA_KEY || 'your-key-here';
    const generator = new AccountGenerator(captchaKey);

    // Check balance
    const balance = await generator.captchaSolver.getBalance();
    console.log(chalk.blue(`[Main] AntiCaptcha balance: $${balance}`));
    
    if (balance < 0.5) {
        console.log(chalk.yellow('[Main] Low balance warning'));
    }

    // Generate accounts
    const targetCount = parseInt(process.env.COUNT) || 5;
    let generated = 0;
    let proxyIndex = 0;

    while (generated < targetCount && proxyIndex < proxies.length) {
        const proxy = proxies[proxyIndex];
        
        try {
            await generator.generateAccount(proxy);
            generated++;
            
            // Rotate to next proxy
            proxyIndex++;
            
            // Delay between accounts
            if (generated < targetCount) {
                const delay = Math.floor(Math.random() * 5000) + 5000;
                console.log(chalk.gray(`[Main] Waiting ${delay}ms...`));
                await new Promise(r => setTimeout(r, delay));
            }
            
        } catch (err) {
            // Failed, try next proxy
            proxyIndex++;
            
            // Small delay on failure
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    generator.printStats();
    
    console.log(chalk.green(`\n[Main] Done! Generated ${generated}/${targetCount} accounts`));
    console.log(chalk.gray('[Main] Saved to accounts.txt'));
    
    process.exit(0);
}

main().catch(err => {
    console.error(chalk.red(`[Fatal] ${err.message}`));
    process.exit(1);
});
