const express = require('express');
const axios = require('axios');
const { Client, GatewayIntentBits, Partials } = require('discord.js-selfbot-v13');
const path = require('path');

const app = express();
app.use(express.json());

const bots = new Map();
const spamState = new Map();

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.post('/login', async (req, res) => {
    const { token, slot } = req.body;
    console.log(`\n[LOGIN][Slot ${slot}] Login attempt started`);
    
    if (!token || slot === undefined) {
        console.log(`[LOGIN][Slot ${slot}] Missing fields`);
        return res.json({ error: 'Missing fields' });
    }

    console.log(`[LOGIN][Slot ${slot}] Token received (length: ${token.length})`);

    // Kill existing
    const existing = bots.get(slot);
    if (existing) {
        console.log(`[LOGIN][Slot ${slot}] Destroying existing client`);
        try { existing.destroy(); } catch(e) { console.log(`[LOGIN][Slot ${slot}] Destroy error:`, e.message); }
        bots.delete(slot);
        spamState.delete(slot);
    }

    // Step 1: REST API validation
    console.log(`[LOGIN][Slot ${slot}] Step 1: Validating token via Discord REST API...`);
    let userData;
    try {
        const validateRes = await axios.get('https://discord.com/api/v10/users/@me', {
            headers: { Authorization: token },
            timeout: 10000
        });
        userData = validateRes.data;
        console.log(`[LOGIN][Slot ${slot}] REST API success: ${userData.username}#${userData.discriminator || '0'} (ID: ${userData.id})`);
    } catch (e) {
        console.log(`[LOGIN][Slot ${slot}] REST API FAILED:`);
        console.log(`  Status: ${e.response?.status || 'no response'}`);
        console.log(`  Message: ${e.message}`);
        console.log(`  Response data:`, e.response?.data || 'none');
        return res.json({ 
            status: 'invalid', 
            error: e.response?.status === 401 ? 'Invalid token (401 from Discord)' : `REST error: ${e.message}`
        });
    }

    // Step 2: Spawn selfbot client
    console.log(`[LOGIN][Slot ${slot}] Step 2: Creating discord.js-selfbot-v13 client...`);
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

    let responded = false;

    const sendResponse = (data) => {
        if (!responded) {
            responded = true;
            res.json(data);
        }
    };

    const timeout = setTimeout(() => {
        console.log(`[LOGIN][Slot ${slot}] TIMEOUT: Client never became ready after 25s`);
        try { client.destroy(); } catch(e) {}
        sendResponse({ status: 'invalid', error: 'Timeout: Client never connected to Discord gateway' });
    }, 25000);

    client.once('ready', () => {
        clearTimeout(timeout);
        console.log(`[LOGIN][Slot ${slot}] SUCCESS: Client ready as ${client.user.tag}`);
        bots.set(slot, client);
        spamState.set(slot, { active: false, channels: [], message: '' });
        sendResponse({
            status: 'valid',
            user: client.user.tag,
            id: client.user.id
        });
    });

    client.once('error', (err) => {
        clearTimeout(timeout);
        console.log(`[LOGIN][Slot ${slot}] CLIENT ERROR:`, err.message);
        console.log(`[LOGIN][Slot ${slot}] Error stack:`, err.stack);
        try { client.destroy(); } catch(e) {}
        sendResponse({ status: 'invalid', error: 'Client error: ' + err.message });
    });

    client.on('shardError', (err) => {
        console.log(`[LOGIN][Slot ${slot}] SHARD ERROR:`, err.message);
    });

    client.on('disconnect', () => {
        console.log(`[LOGIN][Slot ${slot}] CLIENT DISCONNECTED`);
    });

    // Step 3: Login
    console.log(`[LOGIN][Slot ${slot}] Step 3: Calling client.login()...`);
    try {
        await client.login(token);
        console.log(`[LOGIN][Slot ${slot}] client.login() returned successfully`);
    } catch (err) {
        clearTimeout(timeout);
        console.log(`[LOGIN][Slot ${slot}] client.login() THREW ERROR:`);
        console.log(`  Message: ${err.message}`);
        console.log(`  Code: ${err.code || 'none'}`);
        console.log(`  Stack:`, err.stack);
        try { client.destroy(); } catch(e) {}
        sendResponse({ status: 'invalid', error: 'Login exception: ' + err.message });
    }
});

app.post('/configure', (req, res) => {
    const { slot, channels, message } = req.body;
    const state = spamState.get(slot);
    if (!state) return res.json({ error: 'Not logged in' });
    state.channels = channels || [];
    state.message = message || '';
    res.json({ status: 'Configured' });
});

app.post('/spam/start', (req, res) => {
    const { slot } = req.body;
    const client = bots.get(slot);
    const state = spamState.get(slot);
    if (!client || !state) return res.json({ error: 'Not logged in' });
    if (state.active) return res.json({ status: 'Already spamming' });

    state.active = true;
    res.json({ status: 'Spam started' });

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
                    try { await guild.members.fetch({ time: 10000 }).catch(() => {}); } catch (e) {}

                    const members = guild.members.cache.filter(m => !m.user.bot);
                    const memberArray = Array.from(members.values());
                    if (!memberArray.length) continue;

                    const count = Math.min(Math.floor(Math.random() * 3) + 3, memberArray.length);
                    const targets = memberArray.sort(() => 0.5 - Math.random()).slice(0, count);
                    const mentions = targets.map(m => `<@${m.id}>`).join(' ');
                    const fullMsg = `${mentions} ${current.message}`.trim();

                    await channel.send(fullMsg);
                    console.log(`[SPAM][Slot ${slot}] Pinged ${count} in #${channel.name}`);
                    await new Promise(r => setTimeout(r, 1500 + Math.random() * 1500));

                } catch (e) {
                    console.log(`[SPAM][Slot ${slot}] Error: ${e.message}`);
                    await new Promise(r => setTimeout(r, 3000));
                }
            }
        }
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
        if (!guild) return res.json({ error: 'Guild not found' });
        await guild.leave();
        res.json({ status: `Left ${guild.name}` });
    } catch (e) {
        res.json({ error: e.message });
    }
});

app.listen(process.env.PORT || 3000, () => console.log('Panel live on port', process.env.PORT || 3000));
