require('dotenv').config();

module.exports = {
    // AntiCaptcha API key from Railway variables
    ANTICAPTCHA_KEY: process.env.ANTICAPTCHA_KEY,
    
    // Generation settings
    TARGET_COUNT: parseInt(process.env.TARGET_COUNT) || 5,
    MAX_RETRIES: parseInt(process.env.MAX_RETRIES) || 10,
    
    // Proxy settings
    PROXY_TIMEOUT: parseInt(process.env.PROXY_TIMEOUT) || 10000,
    PROXY_CONCURRENCY: parseInt(process.env.PROXY_CONCURRENCY) || 100,
    MIN_PROXIES: parseInt(process.env.MIN_PROXIES) || 50,
    
    // Behavior settings
    HEADLESS: process.env.HEADLESS !== 'false',
    DELAY_MIN: parseInt(process.env.DELAY_MIN) || 3000,
    DELAY_MAX: parseInt(process.env.DELAY_MAX) || 8000,
    
    // Validation
    validate() {
        if (!this.ANTICAPTCHA_KEY || this.ANTICAPTCHA_KEY === 'your-key-here') {
            throw new Error('ANTICAPTCHA_KEY not set in environment variables');
        }
        return true;
    }
};
