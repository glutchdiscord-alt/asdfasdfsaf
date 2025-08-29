const { Client, Collection, GatewayIntentBits, REST, Routes, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits } = require('discord.js');
const { Pool } = require('pg');
const http = require('http');
const cron = require('node-cron');
const { drizzle } = require('drizzle-orm/node-postgres');
const { eq, and, lt } = require('drizzle-orm');
const WebSocket = require('ws');

// WebSocket polyfill for Neon database
global.WebSocket = WebSocket;

// Database configuration for Neon PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 3, // Conservative for hosting limits
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000
});

// Health check server for Render
const server = http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            database: 'connected'
        }));
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Health check server running on port ${PORT}`);
    console.log(`📊 Health endpoint: http://localhost:${PORT}/health`);
});

// Initialize Discord client with production-optimized settings
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates
    ],
    sweepers: {
        messages: {
            interval: 300, // 5 minutes
            lifetime: 1800  // 30 minutes
        },
        users: {
            interval: 600, // 10 minutes
            filter: () => user => user.bot && user.id !== client.user.id
        }
    }
});

// In-memory session storage for performance
const activeSessions = new Map();
const userActiveSessions = new Map();
const emptyChannelTimeouts = new Map();

// Drizzle schema definitions
const { pgTable, text, integer, timestamp, boolean, json } = require('drizzle-orm/pg-core');

const lfgSessions = pgTable('lfg_sessions', {
    id: text('id').primaryKey(),
    creatorId: text('creator_id').notNull(),
    guildId: text('guild_id').notNull(),
    channelId: text('channel_id').notNull(),
    messageId: text('message_id'),
    game: text('game').notNull(),
    gamemode: text('gamemode').notNull(),
    playersNeeded: integer('players_needed').notNull(),
    info: text('info'),
    status: text('status').notNull().default('waiting'),
    currentPlayers: json('current_players').notNull().default([]),
    confirmedPlayers: json('confirmed_players').notNull().default([]),
    voiceChannelId: text('voice_channel_id'),
    confirmationStartTime: timestamp('confirmation_start_time'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    expiresAt: timestamp('expires_at').notNull(),
    isActive: boolean('is_active').notNull().default(true)
});

const guildSettings = pgTable('guild_settings', {
    guildId: text('guild_id').primaryKey(),
    lfgChannelId: text('lfg_channel_id'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow()
});

const userSessions = pgTable('user_sessions', {
    userId: text('user_id').primaryKey(),
    sessionId: text('session_id').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow()
});

const db = drizzle(pool, {
    schema: { lfgSessions, guildSettings, userSessions },
    logger: process.env.NODE_ENV === 'development'
});

// Auto-create tables on startup for deployment environments
async function ensureDatabaseTables(retryCount = 0) {
    try {
        console.log('🔧 Checking database connection and tables...');
        
        // Test database connection first with retry logic
        const client = await pool.connect();
        await client.query('SELECT 1');
        console.log('✅ Database connection verified');
        
        // Create tables if they don't exist (safe for deployment)
        await client.query(`
            CREATE TABLE IF NOT EXISTS lfg_sessions (
                id TEXT PRIMARY KEY,
                creator_id TEXT NOT NULL,
                guild_id TEXT NOT NULL,
                channel_id TEXT NOT NULL,
                message_id TEXT,
                game TEXT NOT NULL,
                gamemode TEXT NOT NULL,
                players_needed INTEGER NOT NULL,
                info TEXT,
                status TEXT NOT NULL DEFAULT 'waiting',
                current_players JSON NOT NULL DEFAULT '[]',
                confirmed_players JSON NOT NULL DEFAULT '[]',
                voice_channel_id TEXT,
                confirmation_start_time TIMESTAMP,
                created_at TIMESTAMP NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
                expires_at TIMESTAMP NOT NULL,
                is_active BOOLEAN NOT NULL DEFAULT true
            );
        `);
        
        await client.query(`
            CREATE TABLE IF NOT EXISTS guild_settings (
                guild_id TEXT PRIMARY KEY,
                lfg_channel_id TEXT,
                created_at TIMESTAMP NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMP NOT NULL DEFAULT NOW()
            );
        `);
        
        await client.query(`
            CREATE TABLE IF NOT EXISTS user_sessions (
                user_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                created_at TIMESTAMP NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMP NOT NULL DEFAULT NOW()
            );
        `);
        
        client.release();
        console.log('✅ Database tables verified/created successfully');
    } catch (error) {
        console.error('❌ Database setup failed:', error);
        console.error('🔍 Check your DATABASE_URL environment variable');
        
        // Retry logic for production hosting
        if (retryCount < 3) {
            console.log(`🔄 Retrying database setup (attempt ${retryCount + 1}/3) in 5 seconds...`);
            await new Promise(resolve => setTimeout(resolve, 5000));
            return ensureDatabaseTables(retryCount + 1);
        }
        
        // If all retries fail, log the error but don't crash the bot
        console.error('❌ Database setup failed after all retries. Bot will continue without database.');
        return;
    }
}

// Database storage class
class DatabaseStorage {
    async createSession(session) {
        try {
            await db.insert(lfgSessions).values({
                id: session.id,
                creatorId: session.creatorId,
                guildId: session.guildId,
                channelId: session.channelId,
                messageId: session.messageId,
                game: session.game,
                gamemode: session.gamemode,
                playersNeeded: session.playersNeeded,
                info: session.info,
                status: session.status,
                currentPlayers: session.currentPlayers,
                confirmedPlayers: session.confirmedPlayers,
                voiceChannelId: session.voiceChannelId,
                expiresAt: session.expiresAt,
                isActive: true
            });
        } catch (error) {
            console.error('Error creating session in database:', error);
        }
    }

    async updateSession(sessionId, updates) {
        try {
            await db.update(lfgSessions)
                .set({ ...updates, updatedAt: new Date() })
                .where(eq(lfgSessions.id, sessionId));
        } catch (error) {
            console.error('Error updating session in database:', error);
        }
    }

    async deleteSession(sessionId) {
        try {
            await db.update(lfgSessions)
                .set({ isActive: false, updatedAt: new Date() })
                .where(eq(lfgSessions.id, sessionId));
        } catch (error) {
            console.error('Error deleting session from database:', error);
        }
    }

    async getActiveSessions() {
        try {
            const sessions = await db.select()
                .from(lfgSessions)
                .where(and(
                    eq(lfgSessions.isActive, true),
                    lt(lfgSessions.expiresAt, new Date())
                ));
            return sessions;
        } catch (error) {
            console.error('Error getting active sessions from database:', error);
            return [];
        }
    }

    async setUserSession(userId, sessionId) {
        try {
            await db.insert(userSessions)
                .values({ userId, sessionId })
                .onConflictDoUpdate({
                    target: userSessions.userId,
                    set: { sessionId, updatedAt: new Date() }
                });
        } catch (error) {
            console.error('Error setting user session in database:', error);
        }
    }

    async removeUserSession(userId) {
        try {
            await db.delete(userSessions)
                .where(eq(userSessions.userId, userId));
        } catch (error) {
            console.error('Error removing user session from database:', error);
        }
    }
}

const storage = new DatabaseStorage();

// Game configurations with modes
const GAMES = {
    valorant: {
        display: "Valorant",
        modes: ["Competitive", "Unrated", "Spike Rush", "Deathmatch"]
    },
    fortnite: {
        display: "Fortnite",
        modes: ["Battle Royale", "Zero Build", "Creative", "Save the World"]
    },
    brawlhalla: {
        display: "Brawlhalla",
        modes: ["1v1", "2v2", "Ranked", "Experimental"]
    },
    thefinals: {
        display: "The Finals",
        modes: ["Quick Cash", "Bank It", "Tournament"]
    },
    roblox: {
        display: "Roblox",
        modes: ["Various", "Roleplay", "Simulator", "Obby"]
    },
    minecraft: {
        display: "Minecraft",
        modes: ["Survival", "Creative", "PvP", "Minigames"]
    },
    marvelrivals: {
        display: "Marvel Rivals",
        modes: ["Quick Match", "Competitive", "Custom"]
    },
    rocketleague: {
        display: "Rocket League",
        modes: ["3v3", "2v2", "1v1", "Hoops"]
    },
    apexlegends: {
        display: "Apex Legends",
        modes: ["Trios", "Duos", "Ranked", "Arenas"]
    },
    callofduty: {
        display: "Call of Duty",
        modes: ["Multiplayer", "Warzone", "Search & Destroy"]
    },
    overwatch: {
        display: "Overwatch",
        modes: ["Competitive", "Quick Play", "Arcade"]
    }
};

// Slash commands registration
const commands = [
    {
        name: 'lfg',
        description: 'Create a Looking for Group session',
        options: [
            {
                type: 3,
                name: 'game',
                description: 'Which game you want to play',
                required: true,
                choices: Object.entries(GAMES).map(([key, game]) => ({
                    name: game.display,
                    value: key
                }))
            },
            {
                type: 3,
                name: 'gamemode',
                description: 'Game mode you want to play',
                required: true,
                autocomplete: true
            },
            {
                type: 4,
                name: 'players',
                description: 'How many players needed (including you)',
                required: true,
                min_value: 2,
                max_value: 10
            },
            {
                type: 3,
                name: 'info',
                description: 'Additional info about your session',
                required: false
            }
        ]
    },
    {
        name: 'quickjoin',
        description: 'Instantly join an available LFG session',
        options: [
            {
                type: 3,
                name: 'game',
                description: 'Which game you want to join',
                required: true,
                choices: Object.entries(GAMES).map(([key, game]) => ({
                    name: game.display,
                    value: key
                }))
            },
            {
                type: 3,
                name: 'gamemode',
                description: 'Preferred game mode',
                required: false,
                autocomplete: true
            }
        ]
    },
    {
        name: 'endlfg',
        description: 'End your active LFG session'
    },
    {
        name: 'help',
        description: 'Show bot commands and features'
    }
];

// Utility functions
function generateSessionId() {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

function getExpirationTime() {
    return new Date(Date.now() + 30 * 60 * 1000); // 30 minutes from now
}

// Helper function to create LFG embed
function createLFGEmbed(session, gameDisplayName) {
    const embed = new EmbedBuilder()
        .setTitle(`🎮 ${gameDisplayName} - ${session.gamemode}`)
        .setColor(0x00ff88)
        .addFields(
            { 
                name: '👥 Players', 
                value: `${session.currentPlayers.length}/${session.playersNeeded}`, 
                inline: true 
            },
            { 
                name: '🎯 Status', 
                value: session.status === 'waiting' ? '🟢 Open' : '🔴 Full', 
                inline: true 
            },
            { 
                name: '⏱️ Session ID', 
                value: `#${session.id.slice(-6)}`, 
                inline: true 
            }
        )
        .setTimestamp()
        .setFooter({ text: 'LFG Bot - Find your gaming squad!' });

    if (session.info) {
        embed.addFields({ name: '📝 Additional Info', value: session.info });
    }

    // Add current players list
    if (session.currentPlayers.length > 0) {
        const playersList = session.currentPlayers.map((player, index) => 
            `${index === 0 ? '👑' : '🎮'} <@${player.id}>`
        ).join('\n');
        embed.addFields({ name: '🏆 Current Squad', value: playersList });
    }

    return embed;
}

// Permission checking utility
async function checkBotPermissions(guild, channel) {
    const botMember = guild.members.me;
    
    if (!botMember.permissions.has(PermissionFlagsBits.ManageChannels)) {
        return { hasPermission: false, message: 'Bot needs "Manage Channels" permission to create voice channels.' };
    }
    
    if (!botMember.permissions.has(PermissionFlagsBits.Connect)) {
        return { hasPermission: false, message: 'Bot needs "Connect" permission for voice channel access.' };
    }
    
    return { hasPermission: true };
}

// Voice channel creation with improved error handling
async function createVoiceChannel(session, guild) {
    try {
        const permissionCheck = await checkBotPermissions(guild);
        if (!permissionCheck.hasPermission) {
            console.error(`Permission error: ${permissionCheck.message}`);
            return null;
        }

        // Find or create game category
        let gameCategory = guild.channels.cache.find(
            c => c.type === ChannelType.GuildCategory && 
            c.name.toLowerCase() === `${GAMES[session.game].display.toLowerCase()}-lfg`
        );

        if (!gameCategory) {
            gameCategory = await guild.channels.create({
                name: `${GAMES[session.game].display}-LFG`,
                type: ChannelType.GuildCategory,
                reason: 'LFG Bot - Game category for organized sessions'
            });
        }

        // Create voice channel
        const voiceChannel = await guild.channels.create({
            name: `🎮 ${session.gamemode} #${session.id.slice(-6)}`,
            type: ChannelType.GuildVoice,
            parent: gameCategory.id,
            userLimit: session.playersNeeded,
            permissionOverwrites: [
                {
                    id: guild.roles.everyone.id,
                    deny: [PermissionFlagsBits.Connect, PermissionFlagsBits.ViewChannel]
                },
                ...session.currentPlayers.map(player => ({
                    id: player.id,
                    allow: [PermissionFlagsBits.Connect, PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Speak]
                }))
            ],
            reason: `LFG Bot - Voice channel for ${session.gamemode} session`
        });

        console.log(`✅ Created voice channel: ${voiceChannel.name} (${voiceChannel.id})`);
        return voiceChannel;
    } catch (error) {
        console.error('Error creating voice channel:', error);
        return null;
    }
}

// Channel cleanup system
async function cleanupEmptyChannel(channelId, guildId) {
    try {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return;

        const channel = guild.channels.cache.get(channelId);
        if (!channel || channel.members.size > 0) {
            emptyChannelTimeouts.delete(channelId);
            return;
        }

        console.log(`🧹 Deleting empty voice channel: ${channel.name}`);
        await channel.delete('LFG Bot - Channel empty for 1 minute');
        emptyChannelTimeouts.delete(channelId);

        // Check if category is now empty and delete it
        if (channel.parent && channel.parent.children.cache.size === 0) {
            console.log(`🧹 Deleting empty category: ${channel.parent.name}`);
            await channel.parent.delete('LFG Bot - Category empty after channel cleanup');
        }
    } catch (error) {
        console.error('Error during channel cleanup:', error);
        emptyChannelTimeouts.delete(channelId);
    }
}

// Session timeout handler
function scheduleSessionTimeout(session) {
    const timeoutId = setTimeout(async () => {
        try {
            console.log(`⏰ Session ${session.id.slice(-6)} expired, cleaning up...`);
            
            activeSessions.delete(session.id);
            session.currentPlayers.forEach(player => {
                userActiveSessions.delete(player.id);
            });
            
            await storage.deleteSession(session.id);
            
            // Delete the original message if it exists
            if (session.messageId && session.channelId) {
                try {
                    const guild = client.guilds.cache.get(session.guildId);
                    const channel = guild?.channels.cache.get(session.channelId);
                    if (channel) {
                        const message = await channel.messages.fetch(session.messageId).catch(() => null);
                        if (message) {
                            await message.delete().catch(console.error);
                        }
                    }
                } catch (error) {
                    console.error('Error deleting expired session message:', error);
                }
            }
            
            console.log(`🗑️ Cleaned up expired session ${session.id.slice(-6)}`);
        } catch (error) {
            console.error('Error in session timeout:', error);
        }
    }, 30 * 60 * 1000); // 30 minutes

    session.timeoutId = timeoutId;
    return timeoutId;
}

// Command handlers
async function handleLFGCommand(interaction) {
    try {
        await interaction.deferReply();

        const game = interaction.options.getString('game');
        const gamemode = interaction.options.getString('gamemode');
        const playersNeeded = interaction.options.getInteger('players');
        const info = interaction.options.getString('info');
        const gameDisplayName = GAMES[game].display;

        // Check if user already has an active session
        if (userActiveSessions.has(interaction.user.id)) {
            return await interaction.editReply({
                content: '❌ **You already have an active LFG session!**\n\nUse `/endlfg` to end your current session before creating a new one.',
                ephemeral: true
            });
        }

        // Validate gamemode
        if (!GAMES[game].modes.includes(gamemode)) {
            return await interaction.editReply({
                content: `❌ **Invalid game mode!**\n\nAvailable modes for ${gameDisplayName}: ${GAMES[game].modes.join(', ')}`,
                ephemeral: true
            });
        }

        // Create session object
        const sessionId = generateSessionId();
        const session = {
            id: sessionId,
            creatorId: interaction.user.id,
            guildId: interaction.guild.id,
            channelId: interaction.channel.id,
            game,
            gamemode,
            playersNeeded,
            info,
            currentPlayers: [{ id: interaction.user.id, username: interaction.user.username }],
            confirmedPlayers: [],
            status: 'waiting',
            createdAt: new Date(),
            expiresAt: getExpirationTime(),
            voiceChannelId: null
        };

        // Create embed and buttons
        const embed = createLFGEmbed(session, gameDisplayName);
        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`join_${sessionId}`)
                    .setLabel('Join Squad')
                    .setStyle(ButtonStyle.Success)
                    .setEmoji('🎮'),
                new ButtonBuilder()
                    .setCustomId(`leave_${sessionId}`)
                    .setLabel('Leave Squad')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('🚪')
            );

        const response = await interaction.editReply({
            embeds: [embed],
            components: [row]
        });

        // Store session data
        session.messageId = response.id;
        activeSessions.set(sessionId, session);
        userActiveSessions.set(interaction.user.id, sessionId);
        
        // Save to database
        await storage.createSession(session);
        await storage.setUserSession(interaction.user.id, sessionId);
        
        // Schedule session timeout
        scheduleSessionTimeout(session);

        console.log(`🚀 LFG Created: ${interaction.user.username} wants ${playersNeeded} for ${gameDisplayName} ${gamemode} (Session #${sessionId.slice(-6)})`);

    } catch (error) {
        console.error('Error in handleLFGCommand:', error);
        
        if (!interaction.replied) {
            await interaction.editReply({
                content: '❌ **LFG creation failed!**\n\nSomething went wrong while creating your session. Please try again.',
                ephemeral: true
            }).catch(console.error);
        }
    }
}

async function handleQuickJoinCommand(interaction) {
    try {
        await interaction.deferReply({ ephemeral: true });

        const game = interaction.options.getString('game');
        const preferredGamemode = interaction.options.getString('gamemode');
        const gameDisplayName = GAMES[game].display;

        // Check if user already has an active session
        if (userActiveSessions.has(interaction.user.id)) {
            return await interaction.editReply({
                content: '❌ **You already have an active LFG session!**\n\nLeave your current session before joining another one.',
                ephemeral: true
            });
        }

        // Find available sessions for the game
        const availableSessions = Array.from(activeSessions.values()).filter(session => 
            session.game === game && 
            session.status === 'waiting' && 
            session.currentPlayers.length < session.playersNeeded &&
            session.guildId === interaction.guild.id
        );

        if (availableSessions.length === 0) {
            return await interaction.editReply({
                content: `❌ **No available ${gameDisplayName} sessions found!**\n\nTry:\n• Using \`/lfg\` to create your own session\n• Checking other game modes\n• Waiting for someone else to create a session`,
                ephemeral: true
            });
        }

        // Prioritize preferred gamemode if specified
        let targetSession;
        if (preferredGamemode) {
            targetSession = availableSessions.find(session => session.gamemode === preferredGamemode);
        }
        
        if (!targetSession) {
            targetSession = availableSessions[0]; // Get first available session
        }

        // Add user to session
        targetSession.currentPlayers.push({
            id: interaction.user.id,
            username: interaction.user.username
        });

        userActiveSessions.set(interaction.user.id, targetSession.id);
        await storage.setUserSession(interaction.user.id, targetSession.id);

        // Update the original message
        const embed = createLFGEmbed(targetSession, GAMES[targetSession.game].display);
        
        try {
            const guild = client.guilds.cache.get(targetSession.guildId);
            const channel = guild?.channels.cache.get(targetSession.channelId);
            if (channel && targetSession.messageId) {
                const message = await channel.messages.fetch(targetSession.messageId);
                await message.edit({ embeds: [embed] });
            }
        } catch (error) {
            console.error('Error updating original LFG message:', error);
        }

        await interaction.editReply({
            content: `✅ **Successfully joined ${gameDisplayName} session!**\n\n🎮 **Game:** ${GAMES[targetSession.game].display}\n🎯 **Mode:** ${targetSession.gamemode}\n👥 **Players:** ${targetSession.currentPlayers.length}/${targetSession.playersNeeded}\n🆔 **Session:** #${targetSession.id.slice(-6)}`,
            ephemeral: true
        });

        // Update session in storage
        await storage.updateSession(targetSession.id, {
            currentPlayers: targetSession.currentPlayers,
            updatedAt: new Date()
        });

        // Check if session is now full and start voice channel creation
        if (targetSession.currentPlayers.length >= targetSession.playersNeeded) {
            console.log(`🎯 Quick Join filled session ${targetSession.id.slice(-6)}! Starting voice channel creation...`);
            targetSession.status = 'full';
            await storage.updateSession(targetSession.id, {
                status: 'completed',
                updatedAt: new Date()
            });
            
            // Clear session timeout if exists
            if (targetSession.timeoutId) {
                clearTimeout(targetSession.timeoutId);
                targetSession.timeoutId = null;
            }
        }
        
        console.log(`🚀 Quick Join: ${interaction.user.username} joined ${gameDisplayName} session #${targetSession.id.slice(-6)}`);
        
    } catch (error) {
        console.error('Error in handleQuickJoinCommand:', error);
        
        if (!interaction.replied) {
            await interaction.editReply({
                content: '❌ **Quick Join failed!**\n\nSomething went wrong while trying to join a session. Please try again or use `/lfg` to create your own session.',
                ephemeral: true
            }).catch(console.error);
        }
    }
}

async function handleEndLFGCommand(interaction) {
    try {
        await interaction.deferReply({ ephemeral: true });

        const userSessionId = userActiveSessions.get(interaction.user.id);
        
        if (!userSessionId) {
            return await interaction.editReply({
                content: '❌ **No active session found!**\n\nYou don\'t have any active LFG sessions to end.',
                ephemeral: true
            });
        }

        const session = activeSessions.get(userSessionId);
        if (!session) {
            userActiveSessions.delete(interaction.user.id);
            await storage.removeUserSession(interaction.user.id);
            return await interaction.editReply({
                content: '❌ **Session not found!**\n\nYour session reference was invalid and has been cleared.',
                ephemeral: true
            });
        }

        // Only session creator can end the session
        if (session.creatorId !== interaction.user.id) {
            return await interaction.editReply({
                content: '❌ **Access denied!**\n\nOnly the session creator can end the session. Use the "Leave Squad" button to leave instead.',
                ephemeral: true
            });
        }

        // Clean up session
        activeSessions.delete(userSessionId);
        
        // Remove all players from user sessions
        session.currentPlayers.forEach(player => {
            userActiveSessions.delete(player.id);
        });

        // Clear timeout if exists
        if (session.timeoutId) {
            clearTimeout(session.timeoutId);
        }

        // Delete from database
        await storage.deleteSession(userSessionId);
        
        // Delete original message
        try {
            const guild = client.guilds.cache.get(session.guildId);
            const channel = guild?.channels.cache.get(session.channelId);
            if (channel && session.messageId) {
                const message = await channel.messages.fetch(session.messageId).catch(() => null);
                if (message) {
                    await message.delete().catch(console.error);
                }
            }
        } catch (error) {
            console.error('Error deleting session message:', error);
        }

        // Delete voice channel if it exists
        if (session.voiceChannelId) {
            try {
                const guild = client.guilds.cache.get(session.guildId);
                const voiceChannel = guild?.channels.cache.get(session.voiceChannelId);
                if (voiceChannel) {
                    await voiceChannel.delete('LFG session ended by creator');
                }
            } catch (error) {
                console.error('Error deleting voice channel:', error);
            }
        }

        await interaction.editReply({
            content: `✅ **LFG session ended successfully!**\n\nSession #${session.id.slice(-6)} has been terminated and all resources cleaned up.`,
            ephemeral: true
        });

        console.log(`🛑 Session ended: ${interaction.user.username} terminated session #${session.id.slice(-6)}`);

    } catch (error) {
        console.error('Error in handleEndLFGCommand:', error);
        
        if (!interaction.replied) {
            await interaction.editReply({
                content: '❌ **End session failed!**\n\nSomething went wrong while ending your session. Please try again.',
                ephemeral: true
            }).catch(console.error);
        }
    }
}

async function handleHelpCommand(interaction) {
    try {
        await interaction.deferReply({ ephemeral: true });

        const helpEmbed = new EmbedBuilder()
            .setTitle('🎮 LFG Bot - Help & Commands')
            .setDescription('**Find your gaming squad with these premium features!**')
            .setColor(0x00ff88)
            .addFields(
                {
                    name: '🎯 `/lfg`',
                    value: 'Create a new Looking for Group session\n• Choose your game and mode\n• Set player count (2-10)\n• Add optional session info\n• Automatic voice channel creation',
                    inline: false
                },
                {
                    name: '⚡ `/quickjoin`',
                    value: 'Instantly join available sessions\n• Select your preferred game\n• Optional gamemode preference\n• Joins first available session\n• Perfect for quick matchmaking',
                    inline: false
                },
                {
                    name: '🛑 `/endlfg`',
                    value: 'End your active LFG session\n• Only session creators can use\n• Cleans up voice channels\n• Removes session from database\n• Notifies all participants',
                    inline: false
                },
                {
                    name: '🎮 Supported Games',
                    value: 'Valorant • Fortnite • Brawlhalla • The Finals\nRoblox • Minecraft • Marvel Rivals • Rocket League\nApex Legends • Call of Duty • Overwatch',
                    inline: false
                },
                {
                    name: '✨ Premium Features',
                    value: '• **Smart Session Management** - One active session per user\n• **Auto Voice Channels** - Private channels for your squad\n• **Session Persistence** - Survives bot restarts\n• **Auto Cleanup** - Removes empty channels after 1 minute\n• **Quick Join System** - Instant matchmaking for popular games',
                    inline: false
                },
                {
                    name: '🔧 How It Works',
                    value: '1️⃣ Create/join a session\n2️⃣ Wait for players to join\n3️⃣ Voice channel auto-created when full\n4️⃣ Game together in your private channel\n5️⃣ Channels auto-cleanup when empty',
                    inline: false
                }
            )
            .setFooter({ text: 'LFG Bot - Premium Discord gaming experience' })
            .setTimestamp();

        await interaction.editReply({
            embeds: [helpEmbed],
            ephemeral: true
        });

    } catch (error) {
        console.error('Error in handleHelpCommand:', error);
        
        if (!interaction.replied) {
            await interaction.editReply({
                content: '❌ **Help command failed!**\n\nSomething went wrong while loading help. Please try again.',
                ephemeral: true
            }).catch(console.error);
        }
    }
}

// Button interaction handlers
async function handleJoinButton(interaction, sessionId) {
    try {
        await interaction.deferReply({ ephemeral: true });

        const session = activeSessions.get(sessionId);
        if (!session) {
            return await interaction.editReply({
                content: '❌ **Session not found!**\n\nThis session may have expired or been ended.',
                ephemeral: true
            });
        }

        // Check if user already has an active session
        if (userActiveSessions.has(interaction.user.id)) {
            return await interaction.editReply({
                content: '❌ **You already have an active LFG session!**\n\nLeave your current session before joining another one.',
                ephemeral: true
            });
        }

        // Check if session is full
        if (session.currentPlayers.length >= session.playersNeeded) {
            return await interaction.editReply({
                content: '❌ **Session is full!**\n\nThis session has reached its player limit.',
                ephemeral: true
            });
        }

        // Check if user is already in this session
        if (session.currentPlayers.some(player => player.id === interaction.user.id)) {
            return await interaction.editReply({
                content: '❌ **Already in session!**\n\nYou\'re already part of this gaming session.',
                ephemeral: true
            });
        }

        // Add user to session
        session.currentPlayers.push({
            id: interaction.user.id,
            username: interaction.user.username
        });

        userActiveSessions.set(interaction.user.id, sessionId);
        await storage.setUserSession(interaction.user.id, sessionId);

        // Update the embed
        const gameDisplayName = GAMES[session.game].display;
        const embed = createLFGEmbed(session, gameDisplayName);

        await interaction.message.edit({ embeds: [embed] });

        await interaction.editReply({
            content: `✅ **Successfully joined the squad!**\n\n🎮 **Game:** ${gameDisplayName}\n🎯 **Mode:** ${session.gamemode}\n👥 **Players:** ${session.currentPlayers.length}/${session.playersNeeded}\n🆔 **Session:** #${sessionId.slice(-6)}`,
            ephemeral: true
        });

        // Update session in storage
        await storage.updateSession(sessionId, {
            currentPlayers: session.currentPlayers,
            updatedAt: new Date()
        });

        // Check if session is now full
        if (session.currentPlayers.length >= session.playersNeeded) {
            console.log(`🎯 Session ${sessionId.slice(-6)} is now full! Starting voice channel creation...`);
            
            session.status = 'full';
            await storage.updateSession(sessionId, {
                status: 'completed',
                updatedAt: new Date()
            });
            
            // Clear session timeout if exists
            if (session.timeoutId) {
                clearTimeout(session.timeoutId);
                session.timeoutId = null;
            }

            // Create voice channel
            const guild = client.guilds.cache.get(session.guildId);
            if (guild) {
                const voiceChannel = await createVoiceChannel(session, guild);
                if (voiceChannel) {
                    session.voiceChannelId = voiceChannel.id;
                    await storage.updateSession(sessionId, {
                        voiceChannelId: voiceChannel.id,
                        updatedAt: new Date()
                    });

                    // Update embed to show voice channel created
                    const finalEmbed = createLFGEmbed(session, gameDisplayName)
                        .addFields({ 
                            name: '🔊 Voice Channel', 
                            value: `<#${voiceChannel.id}>`, 
                            inline: true 
                        });

                    await interaction.message.edit({ 
                        embeds: [finalEmbed],
                        components: [] // Remove buttons when session is complete
                    });

                    // Notify all players in the channel
                    const channel = guild.channels.cache.get(session.channelId);
                    if (channel) {
                        const playerMentions = session.currentPlayers.map(player => `<@${player.id}>`).join(' ');
                        await channel.send(`🎉 **Squad assembled!** ${playerMentions}\n\n🔊 Your private voice channel is ready: <#${voiceChannel.id}>\n🎮 Have fun gaming together!`);
                    }
                }
            }
        }

        console.log(`🚀 Player joined: ${interaction.user.username} joined session #${sessionId.slice(-6)} (${session.currentPlayers.length}/${session.playersNeeded})`);

    } catch (error) {
        console.error('Error in handleJoinButton:', error);
        
        if (!interaction.replied) {
            await interaction.editReply({
                content: '❌ **Join failed!**\n\nSomething went wrong while joining the session. Please try again.',
                ephemeral: true
            }).catch(console.error);
        }
    }
}

async function handleLeaveButton(interaction, sessionId) {
    try {
        await interaction.deferReply({ ephemeral: true });

        const session = activeSessions.get(sessionId);
        if (!session) {
            return await interaction.editReply({
                content: '❌ **Session not found!**\n\nThis session may have expired or been ended.',
                ephemeral: true
            });
        }

        // Check if user is in this session
        const playerIndex = session.currentPlayers.findIndex(player => player.id === interaction.user.id);
        if (playerIndex === -1) {
            return await interaction.editReply({
                content: '❌ **Not in session!**\n\nYou\'re not part of this gaming session.',
                ephemeral: true
            });
        }

        // Remove user from session
        const removedPlayer = session.currentPlayers.splice(playerIndex, 1)[0];
        userActiveSessions.delete(interaction.user.id);
        await storage.removeUserSession(interaction.user.id);

        // If this was the creator and there are other players, transfer ownership
        if (session.creatorId === interaction.user.id && session.currentPlayers.length > 0) {
            session.creatorId = session.currentPlayers[0].id;
            console.log(`👑 Session ownership transferred to ${session.currentPlayers[0].username}`);
        }

        // If session is now empty, delete it
        if (session.currentPlayers.length === 0) {
            activeSessions.delete(sessionId);
            
            // Clear timeout if exists
            if (session.timeoutId) {
                clearTimeout(session.timeoutId);
            }
            
            await storage.deleteSession(sessionId);
            
            // Delete the message
            try {
                await interaction.message.delete();
            } catch (error) {
                console.error('Error deleting empty session message:', error);
            }

            await interaction.editReply({
                content: '✅ **Left session successfully!**\n\nSession was empty and has been automatically deleted.',
                ephemeral: true
            });

            console.log(`🚪 Session deleted: ${removedPlayer.username} left empty session #${sessionId.slice(-6)}`);
            return;
        }

        // Update the embed
        const gameDisplayName = GAMES[session.game].display;
        const embed = createLFGEmbed(session, gameDisplayName);
        await interaction.message.edit({ embeds: [embed] });

        // Update session in storage
        await storage.updateSession(sessionId, {
            currentPlayers: session.currentPlayers,
            creatorId: session.creatorId,
            updatedAt: new Date()
        });

        await interaction.editReply({
            content: `✅ **Successfully left the squad!**\n\nYou've been removed from session #${sessionId.slice(-6)}.`,
            ephemeral: true
        });

        console.log(`🚪 Player left: ${removedPlayer.username} left session #${sessionId.slice(-6)} (${session.currentPlayers.length}/${session.playersNeeded})`);

    } catch (error) {
        console.error('Error in handleLeaveButton:', error);
        
        if (!interaction.replied) {
            await interaction.editReply({
                content: '❌ **Leave failed!**\n\nSomething went wrong while leaving the session. Please try again.',
                ephemeral: true
            }).catch(console.error);
        }
    }
}

// Event handlers
client.on('ready', async () => {
    try {
        console.log('🎉 Bot initialization completed successfully!');
        console.log(`🚀 ${client.user.tag} Bot is online! Logged in as ${client.user.tag}`);
        console.log(`🎮 Serving ${client.guilds.cache.size} servers with premium LFG features`);
        
        // Load persistent sessions from database
        console.log('💾 Loading persistent sessions from database...');
        
        const dbSessions = await storage.getActiveSessions();
        console.log(`📋 Found ${dbSessions.length} active sessions in database`);
        
        // Load guild settings
        console.log('📋 Loading guild settings...');
        console.log(`📋 Loaded settings for 0 guilds`);
        
        // Restore active sessions to memory
        let restoredCount = 0;
        let cleanedCount = 0;
        
        for (const dbSession of dbSessions) {
            try {
                // Check if session has expired
                if (new Date() > new Date(dbSession.expiresAt)) {
                    await storage.deleteSession(dbSession.id);
                    cleanedCount++;
                    continue;
                }
                
                // Restore session to memory
                const session = {
                    id: dbSession.id,
                    creatorId: dbSession.creatorId,
                    guildId: dbSession.guildId,
                    channelId: dbSession.channelId,
                    messageId: dbSession.messageId,
                    game: dbSession.game,
                    gamemode: dbSession.gamemode,
                    playersNeeded: dbSession.playersNeeded,
                    info: dbSession.info,
                    status: dbSession.status,
                    currentPlayers: Array.isArray(dbSession.currentPlayers) ? dbSession.currentPlayers : [],
                    confirmedPlayers: Array.isArray(dbSession.confirmedPlayers) ? dbSession.confirmedPlayers : [],
                    voiceChannelId: dbSession.voiceChannelId,
                    createdAt: dbSession.createdAt,
                    expiresAt: dbSession.expiresAt,
                    timeoutId: null
                };
                
                activeSessions.set(session.id, session);
                
                // Restore user session mappings
                session.currentPlayers.forEach(player => {
                    if (player.id) {
                        userActiveSessions.set(player.id, session.id);
                    }
                });
                
                // Schedule new timeout for remaining time
                const timeLeft = new Date(session.expiresAt).getTime() - Date.now();
                if (timeLeft > 0) {
                    scheduleSessionTimeout(session);
                }
                
                restoredCount++;
            } catch (error) {
                console.error(`Error restoring session ${dbSession.id}:`, error);
                cleanedCount++;
            }
        }
        
        console.log(`✅ Session restoration complete:`);
        console.log(`   🔄 Restored: ${restoredCount} active sessions`);
        console.log(`   🧹 Cleaned: ${cleanedCount} expired sessions`);
        
        // Register slash commands
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        
        console.log('Started refreshing application (/) commands.');
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('Successfully reloaded application (/) commands.');
        
        console.log('🎯 Bot ready and operational!');
        
    } catch (error) {
        console.error('Error during bot initialization:', error);
    }
});

client.on('interactionCreate', async (interaction) => {
    try {
        if (interaction.isChatInputCommand()) {
            switch (interaction.commandName) {
                case 'lfg':
                    await handleLFGCommand(interaction);
                    break;
                case 'quickjoin':
                    await handleQuickJoinCommand(interaction);
                    break;
                case 'endlfg':
                    await handleEndLFGCommand(interaction);
                    break;
                case 'help':
                    await handleHelpCommand(interaction);
                    break;
            }
        } else if (interaction.isButton()) {
            const [action, sessionId] = interaction.customId.split('_');
            
            switch (action) {
                case 'join':
                    await handleJoinButton(interaction, sessionId);
                    break;
                case 'leave':
                    await handleLeaveButton(interaction, sessionId);
                    break;
            }
        } else if (interaction.isAutocomplete()) {
            const focusedOption = interaction.options.getFocused(true);
            
            if (focusedOption.name === 'gamemode') {
                const game = interaction.options.getString('game');
                if (game && GAMES[game]) {
                    const choices = GAMES[game].modes
                        .filter(mode => mode.toLowerCase().includes(focusedOption.value.toLowerCase()))
                        .slice(0, 25)
                        .map(mode => ({ name: mode, value: mode }));
                    
                    await interaction.respond(choices);
                }
            }
        }
    } catch (error) {
        console.error('Error handling interaction:', error);
        
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
            try {
                await interaction.reply({
                    content: '❌ **Something went wrong!**\n\nPlease try again. If the problem persists, contact support.',
                    ephemeral: true
                });
            } catch (replyError) {
                console.error('Error sending error reply:', replyError);
            }
        }
    }
});

// Voice state update handler for channel cleanup
client.on('voiceStateUpdate', (oldState, newState) => {
    try {
        // Check if someone left a voice channel
        if (oldState.channel && oldState.channel !== newState.channel) {
            const channelId = oldState.channel.id;
            const guildId = oldState.guild.id;
            
            // Check if channel is now empty
            if (oldState.channel.members.size === 0) {
                // Set a timeout to delete the channel if it stays empty
                const timeoutId = setTimeout(() => cleanupEmptyChannel(channelId, guildId), 60000); // 1 minute
                emptyChannelTimeouts.set(channelId, timeoutId);
                console.log(`⏰ Started 1-minute cleanup timer for empty voice channel: ${oldState.channel.name}`);
            }
        }
        
        // Check if someone joined a voice channel (cancel cleanup if it was scheduled)
        if (newState.channel) {
            const channelId = newState.channel.id;
            if (emptyChannelTimeouts.has(channelId)) {
                clearTimeout(emptyChannelTimeouts.get(channelId));
                emptyChannelTimeouts.delete(channelId);
                console.log(`✅ Cancelled cleanup timer for voice channel: ${newState.channel.name} (user rejoined)`);
            }
        }
    } catch (error) {
        console.error('Error in voiceStateUpdate handler:', error);
    }
});

// Periodic cleanup task
cron.schedule('*/5 * * * *', async () => {
    try {
        console.log('🧹 Running periodic cleanup...');
        
        let cleanedSessions = 0;
        const currentTime = new Date();
        
        // Clean up expired sessions
        for (const [sessionId, session] of activeSessions) {
            if (currentTime > new Date(session.expiresAt)) {
                console.log(`🗑️ Cleaning expired session: ${sessionId.slice(-6)}`);
                
                // Clean up memory
                activeSessions.delete(sessionId);
                session.currentPlayers.forEach(player => {
                    userActiveSessions.delete(player.id);
                });
                
                // Clear timeout if exists
                if (session.timeoutId) {
                    clearTimeout(session.timeoutId);
                }
                
                // Clean up database
                await storage.deleteSession(sessionId);
                
                cleanedSessions++;
            }
        }
        
        if (cleanedSessions > 0) {
            console.log(`🧹 Periodic cleanup completed: ${cleanedSessions} expired sessions removed`);
        }
        
    } catch (error) {
        console.error('Error during periodic cleanup:', error);
    }
});

// Error handling
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    process.exit(1);
});

// Graceful shutdown handling for deployments
const gracefulShutdown = async (signal) => {
    console.log(`\n🛑 Received ${signal}. Starting graceful shutdown...`);
    
    try {
        // Close database connections
        await pool.end();
        console.log('✅ Database connections closed');
        
        // Close HTTP server
        server.close(() => {
            console.log('✅ HTTP server closed');
        });
        
        // Destroy Discord client
        client.destroy();
        console.log('✅ Discord client destroyed');
        
        console.log('👋 Graceful shutdown completed');
        process.exit(0);
    } catch (error) {
        console.error('❌ Error during graceful shutdown:', error);
        process.exit(1);
    }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGUSR2', () => gracefulShutdown('SIGUSR2')); // Render uses this

// Initialize the bot
async function startBot() {
    try {
        // Setup database first
        await ensureDatabaseTables();
        
        console.log('🔌 Connecting to Discord...');
        await client.login(process.env.DISCORD_TOKEN);
    } catch (error) {
        console.error('❌ Failed to start bot:', error);
        process.exit(1);
    }
}

// Start the bot
startBot();
