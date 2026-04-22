
const express = require('express');
const { Client, GatewayIntentBits, Partials } = require('discord.js-selfbot-v13');
const path = require('path');

const app = express();
app.use(express.json());

const bots = new Map();
const spamState = new Map();

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Auto-login endpoint: validates token, returns username
app.post('/login', async (req, res) => {
    const { token, slot } = req.body;
    if (!token || slot === undefined) return res.json({ error: 'Missing fields' });

    // Kill existing bot in slot if present
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
            GatewayIntentBits.MessageContent
        ],
        partials: [Partials.Channel, Partials.GuildMember]
    });

    client.once('ready', () => {
        console.log(`Slot ${slot} ready: ${client.user.tag}`);
    });

    try {
        await client.login(token);
        bots.set(slot, client);
        spamState.set(slot, { active: false, channels: [], message: '' });
        res.json({ 
            status: 'valid', 
            user: client.user.tag,
            id: client.user.id 
        });
    } catch (err) {
        res.json({ status: 'invalid', error: 'Token rejected' });
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

// FIXED: Start spam loop with proper async handling
app.post('/spam/start', (req, res) => {
    const { slot } = req.body;
    const client = bots.get(slot);
    const state = spamState.get(slot);
    if (!client || !state) return res.json({ error: 'Not logged in' });
    if (state.active) return res.json({ status: 'Already spamming' });

    state.active = true;
    res.json({ status: 'Spam loop engaged' });

    // FIXED: Proper async IIFE to handle the infinite loop
    (async () => {
        while (spamState.get(slot)?.active) {
            const currentState = spamState.get(slot);
            if (!currentState || !currentState.channels.length) {
                await new Promise(r => setTimeout(r, 1000));
                continue;
            }

            for (const chId of currentState.channels) {
                if (!spamState.get(slot)?.active) break;

                try {
                    const channel = await client.channels.fetch(chId).catch(() => null);
                    if (!channel || !channel.isTextBased()) continue;

                    // FIXED: Fetch members properly with caching
                    const guild = channel.guild;
                    await guild.members.fetch({ time: 5000 }).catch(() => {});
                    
                    // Get all non-bot members (online + offline)
                    const members = guild.members.cache.filter(m => !m.user.bot);
                    const memberArray = Array.from(members.values());
                    
                    if (memberArray.length === 0) continue;

                    // Pick 3-5 random targets
                    const count = Math.min(Math.floor(Math.random() * 3) + 3, memberArray.length);
                    const shuffled = memberArray.sort(() => 0.5 - Math.random());
                    const targets = shuffled.slice(0, count);
                    
                    const mentions = targets.map(m => `<@${m.id}>`).join(' ');
                    const fullMsg = `${mentions} ${currentState.message}`;

                    await channel.send(fullMsg);
                    console.log(`[Slot ${slot}] Pinged ${count} users in ${channel.name}`);
                    
                    // Rate limit evasion: 1.5-3s random delay
                    await new Promise(r => setTimeout(r, 1500 + Math.random() * 1500));
                    
                } catch (e) {
                    console.log(`[Slot ${slot}] Error: ${e.message}`);
                    await new Promise(r => setTimeout(r, 3000));
                }
            }
        }
        console.log(`[Slot ${slot}] Spam loop terminated`);
    })();
});

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

        await guild.leave();
        res.json({ status: `Evacuated ${guild.name}`, guildId });
    } catch (e) {
        res.json({ error: e.message });
    }
});

app.listen(process.env.PORT || 3000, () => console.log('Panel live on port', process.env.PORT || 3000));
