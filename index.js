const express = require('express');
const { Client, GatewayIntentBits, Partials } = require('discord.js-selfbot-v13');
const path = require('path');

const app = express();
app.use(express.json());

const bots = new Map();
const spamState = new Map();

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.post('/init', (req, res) => {
    const { token, slot } = req.body;
    if (!token || slot === undefined) return res.json({ error: 'Missing fields' });

    const client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers],
        partials: [Partials.Channel, Partials.GuildMember]
    });

    client.once('ready', () => {
        console.log(`Slot ${slot} active as ${client.user.tag}`);
    });

    client.login(token).catch(() => console.log(`Slot ${slot} failed login`));
    bots.set(slot, client);
    spamState.set(slot, { active: false, channels: [], message: '' });
    res.json({ status: `Slot ${slot} initialized` });
});

app.post('/configure', (req, res) => {
    const { slot, channels, message } = req.body;
    const state = spamState.get(slot);
    if (!state) return res.json({ error: 'Slot not found' });
    state.channels = channels || [];
    state.message = message || '';
    res.json({ status: 'Configured' });
});

app.post('/spam/start', (req, res) => {
    const { slot } = req.body;
    const client = bots.get(slot);
    const state = spamState.get(slot);
    if (!client || !state) return res.json({ error: 'Not initialized' });

    state.active = true;
    res.json({ status: 'Spam loop engaged' });

    const loop = async () => {
        while (spamState.get(slot)?.active) {
            for (const chId of state.channels) {
                const channel = client.channels.cache.get(chId);
                if (!channel || !channel.isTextBased()) continue;

                const guild = channel.guild;
                await guild.members.fetch();
                const members = guild.members.cache.filter(m => !m.user.bot).random(5);
                if (!members.length) continue;

                const mentions = members.map(m => m.toString()).join(' ');
                try {
                    await channel.send(`${mentions} ${state.message}`);
                    await new Promise(r => setTimeout(r, 800));
                } catch (e) {
                    await new Promise(r => setTimeout(r, 2000));
                }
            }
        }
    };
    loop();
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

    const guild = client.guilds.cache.get(guildId);
    if (!guild) return res.json({ error: 'Guild not found' });

    await guild.leave();
    res.json({ status: `Evacuated guild ${guildId}` });
});

app.listen(process.env.PORT || 3000, () => console.log('Panel live'));
