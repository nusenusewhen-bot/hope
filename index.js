const express = require('express');
const { Client, GatewayIntentBits, Partials } = require('discord.js-selfbot-v13');
const path = require('path');

const app = express();
app.use(express.json());

const bots = new Map();
const spamState = new Map();

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// FIXED LOGIN: Proper token validation with working discord.js-selfbot-v13
app.post('/login', async (req, res) => {
    const { token, slot } = req.body;
    if (!token || slot === undefined) return res.json({ error: 'Missing fields' });

    // Destroy existing bot in slot
    const existing = bots.get(slot);
    if (existing) {
        existing.destroy();
        bots.delete(slot);
        spamState.delete(slot);
    }

    // Create validation client with required selfbot options
    const validateClient = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.MessageContent
        ],
        partials: [Partials.Channel, Partials.GuildMember],
        checkUpdate: false, // Disable update checks that cause errors
        readyStatus: false, // Don't set custom status
        patchVoice: false
    });

    // Set timeout for login attempt
    const loginPromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            validateClient.destroy();
            reject(new Error('Login timeout'));
        }, 15000);

        validateClient.once('ready', () => {
            clearTimeout(timeout);
            const userData = {
                tag: validateClient.user.tag,
                id: validateClient.user.id,
                avatar: validateClient.user.displayAvatarURL()
            };
            // Keep this client as the active bot instead of making a new one
            bots.set(slot, validateClient);
            spamState.set(slot, { active: false, channels: [], message: '' });
            resolve(userData);
        });

        validateClient.once('error', (err) => {
            clearTimeout(timeout);
            validateClient.destroy();
            reject(err);
        });

        validateClient.login(token).catch(err => {
            clearTimeout(timeout);
            reject(err);
        });
    });

    try {
        const userData = await loginPromise;
        res.json({
            status: 'valid',
            user: userData.tag,
            id: userData.id
        });
    } catch (err) {
        console.log(`Slot ${slot} login failed:`, err.message);
        res.json({
            status: 'invalid',
            error: err.message.includes('token') ? 'Invalid token' : 'Login failed: ' + err.message
        });
    }
});

// Configure channels and message
app.post('/configure', (req, res) => {
    const { slot, channels, message } = req.body;
    const state = spamState.get(slot);
    if (!state) return res.json({ error: 'Slot not logged in' });
    state.channels = channels || [];
    state.message = message || '';
    res.json({ status: 'Configured', channels: state.channels.length });
});

// FIXED: Working spam loop with guaranteed execution
app.post('/spam/start', (req, res) => {
    const { slot } = req.body;
    const client = bots.get(slot);
    const state = spamState.get(slot);
    if (!client || !state) return res.json({ error: 'Not logged in' });
    if (state.active) return res.json({ status: 'Already spamming' });

    state.active = true;
    res.json({ status: 'Spam loop engaged' });

    // Spawn spam loop in background without blocking response
    setImmediate(() => {
        runSpamLoop(slot, client, state);
    });
});

async function runSpamLoop(slot, client, initialState) {
    console.log(`[Slot ${slot}] Spam loop starting`);
    
    while (true) {
        const currentState = spamState.get(slot);
        if (!currentState || !currentState.active) break;

        const channels = currentState.channels;
        const message = currentState.message;
        
        if (!channels || channels.length === 0) {
            await sleep(1000);
            continue;
        }

        for (const chId of channels) {
            const liveState = spamState.get(slot);
            if (!liveState || !liveState.active) break;

            try {
                // Fetch channel fresh each time
                const channel = await client.channels.fetch(chId).catch(() => null);
                if (!channel || !channel.isTextBased()) {
                    console.log(`[Slot ${slot}] Channel ${chId} not found or not text`);
                    continue;
                }

                const guild = channel.guild;
                
                // Fetch members with force true to get fresh data
                try {
                    await guild.members.fetch({ force: true, time: 10000 });
                } catch (e) {
                    console.log(`[Slot ${slot}] Member fetch failed, using cache`);
                }

                // Get all non-bot members including offline
                const allMembers = guild.members.cache.filter(m => !m.user.bot);
                const memberArray = Array.from(allMembers.values());
                
                if (memberArray.length === 0) {
                    console.log(`[Slot ${slot}] No members found in ${guild.name}`);
                    continue;
                }

                // Pick 3-5 random targets
                const count = Math.min(Math.floor(Math.random() * 3) + 3, memberArray.length);
                const shuffled = memberArray.sort(() => 0.5 - Math.random());
                const targets = shuffled.slice(0, count);
                
                const mentions = targets.map(m => `<@${m.id}>`).join(' ');
                const fullMsg = `${mentions} ${message}`.trim();

                await channel.send(fullMsg);
                console.log(`[Slot ${slot}] Sent to #${channel.name} in ${guild.name}`);
                
                // Randomized delay 1.5-3s to evade rate limits
                await sleep(1500 + Math.random() * 1500);
                
            } catch (e) {
                console.log(`[Slot ${slot}] Error: ${e.message}`);
                await sleep(3000);
            }
        }
    }
    
    console.log(`[Slot ${slot}] Spam loop terminated`);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

app.post('/spam/stop', (req, res) => {
    const { slot } = req.body;
    const state = spamState.get(slot);
    if (state) state.active = false;
    res.json({ status: 'Spam halted' });
});

app.post('/leave', async (req, res) => {
    const { slot, guildId } = req.body;
    const client = bots.get(slot);
    if (!client) return res.json({ error: 'Bot not found' });

    try {
        const guild = await client.guilds.fetch(guildId).catch(() => null);
        if (!guild) return res.json({ error: 'Guild not found or no access' });

        const guildName = guild.name;
        await guild.leave();
        res.json({ status: `Evacuated ${guildName}`, guildId });
    } catch (e) {
        res.json({ error: e.message });
    }
});

app.listen(process.env.PORT || 3000, () => console.log('Panel live on port', process.env.PORT || 3000));
