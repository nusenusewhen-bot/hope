const express = require('express');
const axios = require('axios');
const { Client, GatewayIntentBits, Partials } = require('discord.js-selfbot-v13');
const path = require('path');

const app = express();
app.use(express.json());

const bots = new Map();
const spamState = new Map();

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// WORKING LOGIN: Uses axios REST validation like your example, then spawns client
app.post('/login', async (req, res) => {
    const { token, slot } = req.body;
    if (!token || slot === undefined) return res.json({ error: 'Missing fields' });

    // Kill existing
    const existing = bots.get(slot);
    if (existing) {
        try { existing.destroy(); } catch(e) {}
        bots.delete(slot);
        spamState.delete(slot);
    }

    // Step 1: Validate token via REST API (proven working method from your code)
    let userData;
    try {
        const validateRes = await axios.get('https://discord.com/api/v10/users/@me', {
            headers: { Authorization: token },
            timeout: 8000
        });
        userData = validateRes.data;
    } catch (e) {
        return res.json({ 
            status: 'invalid', 
            error: e.response?.status === 401 ? 'Invalid token' : 'Discord API error: ' + (e.response?.data?.message || e.message)
        });
    }

    // Step 2: Spawn selfbot client with validated token
    const client = new Client({
        checkUpdate: false,
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.DirectMessages
        ],
        partials: [Partials.Channel, Partials.GuildMember, Partials.Message]
    });

    const loginTimeout = setTimeout(() => {
        try { client.destroy(); } catch(e) {}
        bots.delete(slot);
        spamState.delete(slot);
    }, 30000);

    client.once('ready', () => {
        clearTimeout(loginTimeout);
        bots.set(slot, client);
        spamState.set(slot, { active: false, channels: [], message: '' });
        
        res.json({
            status: 'valid',
            user: client.user.tag,
            id: client.user.id,
            username: userData.username,
            global_name: userData.global_name
        });
    });

    client.once('error', (err) => {
        clearTimeout(loginTimeout);
        try { client.destroy(); } catch(e) {}
        res.json({ status: 'invalid', error: 'Client error: ' + err.message });
    });

    try {
        await client.login(token);
    } catch (err) {
        clearTimeout(loginTimeout);
        try { client.destroy(); } catch(e) {}
        res.json({ status: 'invalid', error: 'Login failed: ' + err.message });
    }
});

app.post('/configure', (req, res) => {
    const { slot, channels, message } = req.body;
    const state = spamState.get(slot);
    if (!state) return res.json({ error: 'Not logged in' });
    state.channels = channels || [];
    state.message = message || '';
    res.json({ status: 'Configured', channels: state.channels.length });
});

// FIXED SPAM: Proper working loop with random member pings
app.post('/spam/start', (req, res) => {
    const { slot } = req.body;
    const client = bots.get(slot);
    const state = spamState.get(slot);
    if (!client || !state) return res.json({ error: 'Not logged in' });
    if (state.active) return res.json({ status: 'Already spamming' });

    state.active = true;
    res.json({ status: 'Spam started' });

    // Background spam loop
    (async () => {
        while (spamState.get(slot)?.active) {
            const current = spamState.get(slot);
            if (!current?.channels?.length) {
                await new Promise(r => setTimeout(r, 1000));
                continue;
            }

            for (const chId of current.channels) {
                if (!spamState.get(slot)?.active) break;

                try {
                    const channel = await client.channels.fetch(chId).catch(() => null);
                    if (!channel?.isTextBased()) continue;

                    const guild = channel.guild;
                    
                    // Fetch all members including offline
                    try {
                        await guild.members.fetch({ time: 10000 }).catch(() => {});
                    } catch (e) {}

                    // Get non-bot members
                    const members = guild.members.cache.filter(m => !m.user.bot);
                    const memberArray = Array.from(members.values());
                    
                    if (!memberArray.length) {
                        console.log(`[Slot ${slot}] No members in ${guild.name}`);
                        continue;
                    }

                    // Random 3-5 targets
                    const count = Math.min(Math.floor(Math.random() * 3) + 3, memberArray.length);
                    const targets = memberArray.sort(() => 0.5 - Math.random()).slice(0, count);
                    const mentions = targets.map(m => `<@${m.id}>`).join(' ');
                    const fullMsg = `${mentions} ${current.message}`.trim();

                    await channel.send(fullMsg);
                    console.log(`[Slot ${slot}] Pinged ${count} users in #${channel.name}`);

                    // Random delay 1.5-3s
                    await new Promise(r => setTimeout(r, 1500 + Math.random() * 1500));

                } catch (e) {
                    console.log(`[Slot ${slot}] Error: ${e.message}`);
                    await new Promise(r => setTimeout(r, 3000));
                }
            }
        }
        console.log(`[Slot ${slot}] Spam loop ended`);
    })();
});

app.post('/spam/stop', (req, res) => {
    const { slot } = req.body;
    const state = spamState.get(slot);
    if (state) state.active = false;
    res.json({ status: 'Stopped' });
});

app.post('/leave', async (req, res) => {
    const { slot, guildId } = req.body;
    const client = bots.get(slot);
    if (!client) return res.json({ error: 'Not logged in' });

    try {
        const guild = await client.guilds.fetch(guildId).catch(() => null);
        if (!guild) return res.json({ error: 'Guild not found or no access' });
        
        const name = guild.name;
        await guild.leave();
        res.json({ status: `Left ${name}`, guildId });
    } catch (e) {
        res.json({ error: e.message });
    }
});

app.listen(process.env.PORT || 3000, () => console.log('Panel live on port', process.env.PORT || 3000));
