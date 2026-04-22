const express = require('express');
const { Client, GatewayIntentBits, Partials } = require('discord.js-selfbot-v13');
const path = require('path');

const app = express();
app.use(express.json());

const bots = new Map();
const spamState = new Map();

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// WORKING LOGIN: Proper selfbot initialization
app.post('/login', async (req, res) => {
    const { token, slot } = req.body;
    if (!token || slot === undefined) return res.json({ error: 'Missing fields' });

    // Cleanup existing
    const existing = bots.get(slot);
    if (existing) {
        existing.destroy();
        bots.delete(slot);
        spamState.delete(slot);
    }

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.DirectMessages
        ],
        partials: [Partials.Channel, Partials.GuildMember, Partials.Message],
        checkUpdate: false
    });

    let resolved = false;

    const cleanup = () => {
        if (!resolved) {
            resolved = true;
            client.removeAllListeners();
            try { client.destroy(); } catch(e) {}
        }
    };

    // Set a hard timeout
    const timeout = setTimeout(() => {
        if (!resolved) {
            cleanup();
            res.json({ status: 'invalid', error: 'Login timeout - token may be invalid or Discord API slow' });
        }
    }, 20000);

    client.once('ready', () => {
        if (resolved) return;
        clearTimeout(timeout);
        resolved = true;
        
        bots.set(slot, client);
        spamState.set(slot, { active: false, channels: [], message: '' });
        
        res.json({
            status: 'valid',
            user: client.user.tag,
            id: client.user.id
        });
    });

    client.once('error', (err) => {
        if (resolved) return;
        clearTimeout(timeout);
        cleanup();
        res.json({ status: 'invalid', error: err.message || 'Discord client error' });
    });

    // Catch invalid token specifically
    process.nextTick(() => {
        client.login(token).catch((err) => {
            if (resolved) return;
            clearTimeout(timeout);
            cleanup();
            const msg = err.message || '';
            if (msg.includes('token') || msg.includes('authentication') || msg.includes('401')) {
                res.json({ status: 'invalid', error: 'Invalid token - check your Discord token' });
            } else {
                res.json({ status: 'invalid', error: msg || 'Login failed' });
            }
        });
    });
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

    // Run in background
    runSpam(slot, client, state);
});

async function runSpam(slot, client, initialState) {
    while (spamState.get(slot)?.active) {
        const state = spamState.get(slot);
        if (!state || !state.channels.length) {
            await new Promise(r => setTimeout(r, 1000));
            continue;
        }

        for (const chId of state.channels) {
            const checkState = spamState.get(slot);
            if (!checkState || !checkState.active) break;

            try {
                const channel = await client.channels.fetch(chId).catch(() => null);
                if (!channel?.isTextBased()) continue;

                const guild = channel.guild;
                
                // Try to fetch members
                try {
                    await guild.members.fetch({ cache: true });
                } catch (e) {}

                const members = guild.members.cache.filter(m => !m.user.bot);
                const arr = Array.from(members.values());
                if (!arr.length) continue;

                const count = Math.min(Math.floor(Math.random() * 3) + 3, arr.length);
                const targets = arr.sort(() => 0.5 - Math.random()).slice(0, count);
                const mentions = targets.map(m => `<@${m.id}>`).join(' ');
                
                await channel.send(`${mentions} ${state.message}`.trim());
                console.log(`[Slot ${slot}] Pinged ${count} in #${channel.name}`);
                
                await new Promise(r => setTimeout(r, 1500 + Math.random() * 1500));
            } catch (e) {
                console.log(`[Slot ${slot}] Error: ${e.message}`);
                await new Promise(r => setTimeout(r, 3000));
            }
        }
    }
    console.log(`[Slot ${slot}] Spam ended`);
}

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

app.listen(process.env.PORT || 3000, () => console.log('Panel live'));
