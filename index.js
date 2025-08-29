const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, ButtonBuilder, ActionRowBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const { Pool } = require('@neondatabase/serverless');
const { drizzle } = require('drizzle-orm/neon-serverless');
const { pgTable, text, timestamp, integer, boolean, json } = require('drizzle-orm/pg-core');
const { eq, and, ne } = require('drizzle-orm');
const cron = require('node-cron');
const http = require('http');
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
            status: 'ok',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            discord: client?.isReady() ? 'connected' : 'disconnected',
            database: 'available'
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

// Database schema definitions
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
            const [createdSession] = await db
                .insert(lfgSessions)
                .values({
                    ...session,
                    expiresAt: new Date(Date.now() + 20 * 60 * 1000),
                    updatedAt: new Date()
                })
                .returning();
            return createdSession;
        } catch (error) {
            console.error('❌ Database error creating session:', error);
            throw error;
        }
    }

    async getSession(sessionId) {
        try {
            const [session] = await db
                .select()
                .from(lfgSessions)
                .where(and(eq(lfgSessions.id, sessionId), eq(lfgSessions.isActive, true)));
            return session || undefined;
        } catch (error) {
            console.error('❌ Database error getting session:', error);
            throw error;
        }
    }

    async updateSession(sessionId, updates) {
        try {
            const [updatedSession] = await db
                .update(lfgSessions)
                .set({ ...updates, updatedAt: new Date() })
                .where(eq(lfgSessions.id, sessionId))
                .returning();
            return updatedSession;
        } catch (error) {
            console.error('❌ Database error updating session:', error);
            throw error;
        }
    }

    async deleteSession(sessionId) {
        try {
            await db
                .update(lfgSessions)
                .set({ isActive: false, updatedAt: new Date() })
                .where(eq(lfgSessions.id, sessionId));
        } catch (error) {
            console.error('❌ Database error deleting session:', error);
            throw error;
        }
    }

    async getActiveSessions() {
        try {
            const sessions = await db
                .select()
                .from(lfgSessions)
                .where(eq(lfgSessions.isActive, true));
            return sessions;
        } catch (error) {
            console.error('❌ Database error getting active sessions:', error);
            return [];
        }
    }

    async setUserSession(userId, sessionId) {
        try {
            await db
                .insert(userSessions)
                .values({ userId, sessionId, updatedAt: new Date() })
                .onConflictDoUpdate({
                    target: userSessions.userId,
                    set: { sessionId, updatedAt: new Date() }
                });
        } catch (error) {
            console.error('❌ Database error setting user session:', error);
            throw error;
        }
    }

    async getUserSession(userId) {
        try {
            const [userSession] = await db
                .select()
                .from(userSessions)
                .where(eq(userSessions.userId, userId));
            return userSession?.sessionId;
        } catch (error) {
            console.error('❌ Database error getting user session:', error);
            return null;
        }
    }

    async removeUserSession(userId) {
        try {
            await db
                .delete(userSessions)
                .where(eq(userSessions.userId, userId));
        } catch (error) {
            console.error('❌ Database error removing user session:', error);
            throw error;
        }
    }
}

const storage = new DatabaseStorage();

// Discord client setup optimized for production hosting
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
    ],
    sweepers: {
        messages: {
            interval: 60,
            lifetime: 1800,
        },
        users: {
            interval: 60,
            filter: () => user => user.bot && user.id !== client.user.id,
        }
    },
    allowedMentions: {
        parse: ['users'],
        repliedUser: false
    }
});

// Optimized in-memory caches with performance monitoring
const activeSessions = new Map();
const userCreatedSessions = new Map();
const emptyChannelTimestamps = new Map();
const sessionTimeouts = new Map();
const guildSettingsCache = new Map();
const userSessionCache = new Map(); // Cache user sessions for faster lookup
const gameModesCache = new Map(); // Cache processed game modes
const permissionCache = new Map(); // Cache permission checks

// Game configurations
const games = [
    { name: 'Valorant', value: 'valorant' },
    { name: 'Fortnite', value: 'fortnite' },
    { name: 'Brawlhalla', value: 'brawlhalla' },
    { name: 'The Finals', value: 'thefinals' },
    { name: 'Roblox', value: 'roblox' },
    { name: 'Minecraft', value: 'minecraft' },
    { name: 'Marvel Rivals', value: 'marvelrivals' },
    { name: 'Rocket League', value: 'rocketleague' },
    { name: 'Apex Legends', value: 'apexlegends' },
    { name: 'Call of Duty', value: 'callofduty' },
    { name: 'Overwatch', value: 'overwatch' }
];

const gameModes = {
    valorant: ['Competitive', 'Unrated', 'Spike Rush', 'Deathmatch'],
    fortnite: ['Battle Royale', 'Zero Build', 'Creative', 'Save the World'],
    brawlhalla: ['1v1', '2v2', 'Ranked', 'Experimental'],
    thefinals: ['Quick Cash', 'Bank It', 'Tournament'],
    roblox: ['Various', 'Roleplay', 'Simulator', 'Obby'],
    minecraft: ['Survival', 'Creative', 'PvP', 'Minigames'],
    marvelrivals: ['Quick Match', 'Competitive', 'Custom'],
    rocketleague: ['3v3', '2v2', '1v1', 'Hoops'],
    apexlegends: ['Trios', 'Duos', 'Ranked', 'Arenas'],
    callofduty: ['Multiplayer', 'Warzone', 'Search & Destroy'],
    overwatch: ['Competitive', 'Quick Play', 'Arcade']
};

// Optimized permission checking with caching
function hasRequiredPermissions(guild, member) {
    const cacheKey = `perms_${guild.id}_${member?.id || 'bot'}`;
    
    // Check cache first (valid for 5 minutes)
    const cached = permissionCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < 300000) {
        return cached.result;
    }
    
    try {
        let result = false;
        
        // Check if user has administrator permission
        if (member && member.permissions.has(PermissionFlagsBits.Administrator)) {
            result = true;
        } else {
            // Get bot member and check specific permissions
            const botMember = guild.members.cache.get(client.user.id) || guild.members.me;
            if (!botMember) {
                console.error('❌ Bot member not found in guild cache');
                result = false;
            } else if (botMember.permissions.has(PermissionFlagsBits.Administrator)) {
                result = true;
            } else {
                // Check individual required permissions
                const requiredPermissions = [
                    PermissionFlagsBits.ManageChannels,
                    PermissionFlagsBits.Connect
                ];
                
                result = requiredPermissions.every(permission => 
                    botMember.permissions.has(permission)
                );
            }
        }
        
        // Cache result
        permissionCache.set(cacheKey, { result, timestamp: Date.now() });
        
        // Clean old cache entries
        if (permissionCache.size > 1000) {
            const now = Date.now();
            for (const [key, value] of permissionCache.entries()) {
                if (now - value.timestamp > 300000) {
                    permissionCache.delete(key);
                }
            }
        }
        
        return result;
        
    } catch (error) {
        console.error('❌ Error checking permissions:', error);
        return false;
    }
}

// Generate unique session ID
function generateSessionId() {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// Create safe category name
function createSafeCategoryName(gameName) {
    return `🎮 ${gameName}`.substring(0, 100);
}

// Create safe channel name
function createSafeChannelName(gameName, gamemode, sessionId) {
    const shortId = sessionId.slice(-6);
    return `${gameName}-${gamemode}-${shortId}`.toLowerCase().replace(/[^a-z0-9-]/g, '').substring(0, 100);
}

// Get or create game category with enhanced error handling
async function getOrCreateGameCategory(guild, gameName) {
    try {
        const categoryName = createSafeCategoryName(gameName);
        
        // Look for existing category (case-insensitive)
        let category = guild.channels.cache.find(channel => 
            channel.type === 4 && // CategoryChannel type
            channel.name.toLowerCase() === categoryName.toLowerCase()
        );

        if (!category) {
            console.log(`📁 Creating new category: ${categoryName}`);
            category = await guild.channels.create({
                name: categoryName,
                type: 4, // CategoryChannel
                reason: 'LFG Bot: Creating game category for voice channels'
            });
            console.log(`✅ Created category: ${category.name}`);
        }

        return category;
    } catch (error) {
        console.error(`❌ Failed to get/create category for ${gameName}:`, error);
        throw error;
    }
}

// Create private voice channel with enhanced error handling
async function createPrivateVoiceChannel(guild, gameName, gamemode, sessionId, members) {
    try {
        console.log(`🔊 Creating voice channel for ${gameName} - ${gamemode}`);
        
        const category = await getOrCreateGameCategory(guild, gameName);
        const channelName = createSafeChannelName(gameName, gamemode, sessionId);

        // Create permission overwrites for members
        const permissionOverwrites = [
            {
                id: guild.roles.everyone.id,
                deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]
            },
            {
                id: client.user.id,
                allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.ManageChannels]
            }
        ];

        // Add permissions for each member
        members.forEach(member => {
            permissionOverwrites.push({
                id: member.id,
                allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]
            });
        });

        const voiceChannel = await guild.channels.create({
            name: channelName,
            type: 2, // VoiceChannel
            parent: category.id,
            permissionOverwrites: permissionOverwrites,
            reason: `LFG Bot: Creating private voice channel for ${gameName} session`
        });

        console.log(`✅ Created voice channel: ${voiceChannel.name}`);
        return voiceChannel;

    } catch (error) {
        console.error(`❌ Failed to create voice channel for ${gameName}:`, error);
        throw error;
    }
}

// Enhanced permission error message
function getPermissionErrorMessage() {
    return '❌ **Bot is missing required permissions!** Please ensure the bot has:\n\n' +
           '• **Manage Channels** permission\n' +
           '• **Connect** to voice channels permission\n\n' +
           'Contact a server admin to fix bot permissions.';
}

// Create LFG embed with enhanced styling
function createLFGEmbed(session) {
    const gameDisplayName = games.find(g => g.value === session.game)?.name || session.game;
    const slotsText = `${session.currentPlayers.length}/${session.playersNeeded}`;
    const statusEmoji = session.currentPlayers.length >= session.playersNeeded ? '✅' : '🔍';
    
    const embed = new EmbedBuilder()
        .setTitle(`${statusEmoji} ${gameDisplayName} - ${session.gamemode}`)
        .setColor(session.currentPlayers.length >= session.playersNeeded ? 0x00ff00 : 0x3498db)
        .addFields(
            { name: '👥 Players', value: slotsText, inline: true },
            { name: '🎮 Game Mode', value: session.gamemode, inline: true },
            { name: '👤 Created by', value: `<@${session.creatorId}>`, inline: true }
        )
        .setFooter({ text: `Session ID: ${session.id.slice(-6)} | Created` })
        .setTimestamp(new Date(session.createdAt));

    if (session.info) {
        embed.addFields({ name: '📝 Additional Info', value: session.info });
    }

    if (session.currentPlayers.length > 0) {
        const playerList = session.currentPlayers.map(player => `• <@${player.id}>`).join('\n');
        embed.addFields({ name: '🎯 Current Players', value: playerList });
    }

    return embed;
}

// Create action buttons for LFG sessions
function createLFGButtons(sessionId, isFull = false) {
    const joinButton = new ButtonBuilder()
        .setCustomId(`join_${sessionId}`)
        .setLabel('Join Session')
        .setStyle(ButtonStyle.Success)
        .setEmoji('🎮')
        .setDisabled(isFull);

    const leaveButton = new ButtonBuilder()
        .setCustomId(`leave_${sessionId}`)
        .setLabel('Leave Session')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🚪');

    return new ActionRowBuilder().addComponents(joinButton, leaveButton);
}

// Start voice channel creation process
async function startVoiceChannelCreation(session) {
    try {
        const guild = client.guilds.cache.get(session.guildId);
        if (!guild) {
            console.error('❌ Guild not found for voice channel creation');
            return;
        }

        // Check permissions before creating channel
        if (!hasRequiredPermissions(guild, null)) {
            console.error('❌ Missing permissions for voice channel creation');
            return;
        }

        // Get member objects for voice channel permissions
        const members = [];
        for (const player of session.currentPlayers) {
            try {
                const member = await guild.members.fetch(player.id);
                if (member) members.push(member);
            } catch (error) {
                console.error(`❌ Failed to fetch member ${player.id}:`, error);
            }
        }

        if (members.length === 0) {
            console.error('❌ No valid members found for voice channel');
            return;
        }

        // Create the voice channel
        const voiceChannel = await createPrivateVoiceChannel(
            guild, 
            session.game, 
            session.gamemode, 
            session.id, 
            members
        );

        // Update session with voice channel ID
        session.voiceChannelId = voiceChannel.id;
        await storage.updateSession(session.id, { voiceChannelId: voiceChannel.id });

        console.log(`✅ Voice channel created for session ${session.id.slice(-6)}: ${voiceChannel.name}`);

        // Update the session message with voice channel info
        await updateSessionMessage(session);

        // Start monitoring for empty channel cleanup
        startEmptyChannelMonitoring(voiceChannel.id);

    } catch (error) {
        console.error('❌ Failed to create voice channel:', error);
        
        // Update session status to indicate voice channel creation failed
        session.status = 'voice_creation_failed';
        await storage.updateSession(session.id, { status: 'voice_creation_failed' });
        await updateSessionMessage(session);
    }
}

// Update session message with current status
async function updateSessionMessage(session, interaction = null) {
    try {
        const guild = client.guilds.cache.get(session.guildId);
        if (!guild) return;

        const channel = guild.channels.cache.get(session.channelId);
        if (!channel) return;

        const embed = createLFGEmbed(session);
        const buttons = createLFGButtons(session.id, session.currentPlayers.length >= session.playersNeeded);

        // Add voice channel info if available
        if (session.voiceChannelId) {
            embed.addFields({ 
                name: '🔊 Voice Channel', 
                value: `<#${session.voiceChannelId}>`, 
                inline: true 
            });
        }

        const messagePayload = {
            embeds: [embed],
            components: [buttons]
        };

        if (session.messageId) {
            // Update existing message
            try {
                const message = await channel.messages.fetch(session.messageId);
                await message.edit(messagePayload);
            } catch (error) {
                console.error('❌ Failed to update existing message:', error);
                // If message doesn't exist, create a new one
                const newMessage = await channel.send(messagePayload);
                session.messageId = newMessage.id;
                await storage.updateSession(session.id, { messageId: newMessage.id });
            }
        } else {
            // Create new message
            const message = await channel.send(messagePayload);
            session.messageId = message.id;
            await storage.updateSession(session.id, { messageId: message.id });
        }

    } catch (error) {
        console.error('❌ Failed to update session message:', error);
    }
}

// Handle user joining session
async function handleJoinSession(interaction, sessionId) {
    try {
        await interaction.deferReply({ flags: 64 });

        const session = activeSessions.get(sessionId);
        if (!session) {
            return interaction.editReply({
                content: '❌ **Session not found!**\n\nThis LFG session may have expired or been deleted.',
            });
        }

        const userId = interaction.user.id;

        // Check if user is already in this session
        if (session.currentPlayers.some(player => player.id === userId)) {
            return interaction.editReply({
                content: '✅ **You\'re already in this session!**\n\n🎮 You\'re all set to play.',
            });
        }

        // Check if session is full
        if (session.currentPlayers.length >= session.playersNeeded) {
            return interaction.editReply({
                content: '❌ **Session is full!**\n\n🔍 Look for other sessions or create your own with `/lfg`.',
            });
        }

        // Check if user is already in another session
        const existingUserSession = userCreatedSessions.get(userId);
        if (existingUserSession && existingUserSession !== sessionId) {
            return interaction.editReply({
                content: '❌ **You\'re already in another LFG session!**\n\n' +
                        '🎮 You can only be in one session at a time\n' +
                        '💡 Leave your current session first to join this one',
            });
        }

        // Check if user is a participant in any other session
        const participantSession = Array.from(activeSessions.values()).find(s => 
            s.id !== sessionId && s.currentPlayers.some(player => player.id === userId)
        );

        if (participantSession) {
            return interaction.editReply({
                content: '❌ **You\'re already in another LFG session!**\n\n' +
                        `🎮 Currently in: **${participantSession.game}** - ${participantSession.gamemode}\n` +
                        '💡 Leave that session first to join this one',
            });
        }

        // Add user to session
        session.currentPlayers.push({
            id: userId,
            username: interaction.user.username,
            joinedAt: new Date().toISOString()
        });

        // Update database
        await storage.updateSession(sessionId, {
            currentPlayers: session.currentPlayers,
            updatedAt: new Date()
        });

        // Track user session
        await storage.setUserSession(userId, sessionId);

        const gameDisplayName = games.find(g => g.value === session.game)?.name || session.game;

        await interaction.editReply({
            content: `✅ **Successfully joined ${gameDisplayName}!**\n\n` +
                    `🎮 **Game:** ${gameDisplayName} - ${session.gamemode}\n` +
                    `👥 **Players:** ${session.currentPlayers.length}/${session.playersNeeded}\n` +
                    `👤 **Session Creator:** <@${session.creatorId}>`,
        });

        // Check if session is now full and start voice channel creation
        if (session.currentPlayers.length >= session.playersNeeded) {
            console.log(`🎯 Session ${sessionId.slice(-6)} is now full! Starting voice channel creation...`);
            session.status = 'full';
            await storage.updateSession(sessionId, { status: 'full' });
            
            // Start voice channel creation
            await startVoiceChannelCreation(session);
        }

        // Update the session message
        await updateSessionMessage(session);

        console.log(`🎮 User ${interaction.user.username} joined ${gameDisplayName} session ${sessionId.slice(-6)}`);

    } catch (error) {
        console.error('❌ Error in handleJoinSession:', error);
        
        if (!interaction.replied) {
            await interaction.editReply({
                content: '❌ **Failed to join session!**\n\nSomething went wrong. Please try again.',
            }).catch(console.error);
        }
    }
}

// Handle user leaving session
async function handleLeaveSession(interaction, sessionId) {
    try {
        await interaction.deferReply({ flags: 64 });

        const session = activeSessions.get(sessionId);
        if (!session) {
            return interaction.editReply({
                content: '❌ **Session not found!**\n\nThis LFG session may have expired or been deleted.',
            });
        }

        const userId = interaction.user.id;

        // Check if user is in this session
        const playerIndex = session.currentPlayers.findIndex(player => player.id === userId);
        if (playerIndex === -1) {
            return interaction.editReply({
                content: '❌ **You\'re not in this session!**\n\n🔍 You can only leave sessions you\'ve joined.',
            });
        }

        // Remove user from session
        session.currentPlayers.splice(playerIndex, 1);

        // Update database
        await storage.updateSession(sessionId, {
            currentPlayers: session.currentPlayers,
            updatedAt: new Date()
        });

        // Remove user session tracking
        await storage.removeUserSession(userId);

        const gameDisplayName = games.find(g => g.value === session.game)?.name || session.game;

        await interaction.editReply({
            content: `✅ **Successfully left ${gameDisplayName} session!**\n\n` +
                    '🔍 You can now join other sessions or create your own.',
        });

        // If this was the session creator leaving, end the session
        if (userId === session.creatorId) {
            console.log(`👤 Session creator left session ${sessionId.slice(-6)}, ending session...`);
            await endLFGSession(sessionId, 'creator_left');
            return;
        }

        // Update session status if it's no longer full
        if (session.currentPlayers.length < session.playersNeeded && session.status === 'full') {
            session.status = 'waiting';
            await storage.updateSession(sessionId, { status: 'waiting' });
        }

        // If session becomes empty, clean it up
        if (session.currentPlayers.length === 0) {
            console.log(`🧹 Session ${sessionId.slice(-6)} is now empty, cleaning up...`);
            await endLFGSession(sessionId, 'empty');
            return;
        }

        // Update the session message
        await updateSessionMessage(session);

        console.log(`🚪 User ${interaction.user.username} left ${gameDisplayName} session ${sessionId.slice(-6)}`);

    } catch (error) {
        console.error('❌ Error in handleLeaveSession:', error);
        
        if (!interaction.replied) {
            await interaction.editReply({
                content: '❌ **Failed to leave session!**\n\nSomething went wrong. Please try again.',
            }).catch(console.error);
        }
    }
}

// End LFG session and cleanup
async function endLFGSession(sessionId, reason = 'manual') {
    try {
        const session = activeSessions.get(sessionId);
        if (!session) {
            console.log(`⚠️ Attempted to end non-existent session: ${sessionId}`);
            return;
        }

        console.log(`🛑 Ending LFG session ${sessionId.slice(-6)} (reason: ${reason})`);

        // Clean up voice channel if it exists
        if (session.voiceChannelId) {
            try {
                const guild = client.guilds.cache.get(session.guildId);
                if (guild) {
                    const voiceChannel = guild.channels.cache.get(session.voiceChannelId);
                    if (voiceChannel) {
                        console.log(`🗑️ Deleting voice channel: ${voiceChannel.name}`);
                        await voiceChannel.delete('LFG session ended');
                        
                        // Check if category is now empty and clean it up
                        if (voiceChannel.parent) {
                            await cleanupEmptyCategory(voiceChannel.parent);
                        }
                    }
                }
            } catch (error) {
                console.error(`❌ Failed to delete voice channel for session ${sessionId}:`, error);
            }
        }

        // Remove user session tracking for all participants
        for (const player of session.currentPlayers) {
            await storage.removeUserSession(player.id);
        }

        // Remove session creator tracking
        userCreatedSessions.delete(session.creatorId);

        // Update database to mark session as inactive
        await storage.deleteSession(sessionId);

        // Remove from active sessions
        activeSessions.delete(sessionId);

        // Clear any timeouts
        if (sessionTimeouts.has(sessionId)) {
            clearTimeout(sessionTimeouts.get(sessionId));
            sessionTimeouts.delete(sessionId);
        }

        // Update the session message to show it's ended
        try {
            const guild = client.guilds.cache.get(session.guildId);
            if (guild) {
                const channel = guild.channels.cache.get(session.channelId);
                if (channel && session.messageId) {
                    const message = await channel.messages.fetch(session.messageId);
                    if (message) {
                        const embed = new EmbedBuilder()
                            .setTitle(`⛔ Session Ended - ${games.find(g => g.value === session.game)?.name || session.game}`)
                            .setColor(0x95a5a6)
                            .setDescription('This LFG session has ended.')
                            .setFooter({ text: `Session ID: ${sessionId.slice(-6)} | Ended` })
                            .setTimestamp();

                        await message.edit({
                            embeds: [embed],
                            components: []
                        });
                    }
                }
            }
        } catch (error) {
            console.error(`❌ Failed to update ended session message:`, error);
        }

        console.log(`✅ Successfully ended session ${sessionId.slice(-6)}`);

    } catch (error) {
        console.error(`❌ Error ending session ${sessionId}:`, error);
    }
}

// Start monitoring empty voice channel for cleanup
function startEmptyChannelMonitoring(channelId) {
    emptyChannelTimestamps.set(channelId, Date.now());
}

// Stop monitoring voice channel
function stopEmptyChannelMonitoring(channelId) {
    emptyChannelTimestamps.delete(channelId);
}

// Clean up empty categories
async function cleanupEmptyCategory(category) {
    try {
        if (!category || category.children.cache.size > 0) {
            return; // Category not empty
        }

        console.log(`🗑️ Cleaning up empty category: ${category.name}`);
        await category.delete('Empty game category cleanup');
        console.log(`✅ Deleted empty category: ${category.name}`);

    } catch (error) {
        console.error(`❌ Failed to cleanup category ${category?.name}:`, error);
    }
}

// Optimized cleanup with performance monitoring and batching
let cleanupRunning = false;
const cleanupStats = { runs: 0, channels: 0, sessions: 0, errors: 0, totalTime: 0 };

async function cleanupExpiredSessions() {
    if (cleanupRunning) {
        console.log('⏩ Skipping cleanup - previous run still in progress');
        return;
    }
    
    cleanupRunning = true;
    const startTime = Date.now();
    cleanupStats.runs++;
    
    try {
        const now = Date.now();
        const sessionsToEnd = [];
        const channelsToCleanup = [];
        const categoriesToCheck = new Set();

        // Batch collect expired sessions (more efficient than individual processing)
        for (const [sessionId, session] of activeSessions) {
            const sessionAge = now - new Date(session.createdAt).getTime();
            const maxAge = 20 * 60 * 1000; // 20 minutes

            if (sessionAge > maxAge) {
                console.log(`⏰ Session ${sessionId.slice(-6)} expired (${Math.round(sessionAge / 60000)} minutes old)`);
                sessionsToEnd.push(sessionId);
            }
        }

        // Batch collect empty channels for cleanup
        for (const [channelId, timestamp] of emptyChannelTimestamps) {
            const emptyDuration = now - timestamp;
            const maxEmptyTime = 90000; // Increased to 1.5 minutes for stability

            if (emptyDuration > maxEmptyTime) {
                const channel = client.channels.cache.get(channelId);
                if (channel && channel.members.size === 0) {
                    channelsToCleanup.push({ channel, channelId });
                    if (channel.parent) categoriesToCheck.add(channel.parent);
                } else {
                    emptyChannelTimestamps.delete(channelId);
                }
            }
        }

        // Execute cleanup operations in parallel batches
        const cleanupPromises = [];
        
        // End expired sessions in batches of 3
        for (let i = 0; i < sessionsToEnd.length; i += 3) {
            const batch = sessionsToEnd.slice(i, i + 3);
            cleanupPromises.push(
                Promise.allSettled(batch.map(async (sessionId) => {
                    try {
                        await endLFGSession(sessionId, 'expired');
                        cleanupStats.sessions++;
                    } catch (error) {
                        cleanupStats.errors++;
                        console.error(`❌ Error ending session ${sessionId}:`, error);
                    }
                }))
            );
        }
        
        // Cleanup channels in batches of 2 (Discord rate limits)
        for (let i = 0; i < channelsToCleanup.length; i += 2) {
            const batch = channelsToCleanup.slice(i, i + 2);
            cleanupPromises.push(
                Promise.allSettled(batch.map(async ({ channel, channelId }) => {
                    try {
                        console.log(`🗑️ Cleaning up empty voice channel: ${channel.name}`);
                        await channel.delete('Empty voice channel cleanup');
                        emptyChannelTimestamps.delete(channelId);
                        cleanupStats.channels++;
                    } catch (error) {
                        cleanupStats.errors++;
                        console.error(`❌ Error cleaning up channel ${channelId}:`, error);
                        emptyChannelTimestamps.delete(channelId);
                    }
                }))
            );
        }
        
        // Wait for all cleanup operations to complete
        await Promise.allSettled(cleanupPromises);
        
        // Cleanup empty categories after channel deletion
        for (const category of categoriesToCheck) {
            try {
                await cleanupEmptyCategory(category);
            } catch (error) {
                console.error(`❌ Error cleaning up category:`, error);
            }
        }
        
        // Save session data periodically (every 3rd run for performance)
        if (cleanupStats.runs % 3 === 0) {
            await saveSessionData();
        }
        
        const duration = Date.now() - startTime;
        cleanupStats.totalTime += duration;
        
        // Log performance warning for slow cleanups
        if (duration > 3000) {
            console.log(`⚠️ Cleanup took ${duration}ms - consider optimization`);
        }
        
    } catch (error) {
        cleanupStats.errors++;
        console.error('❌ Error in cleanup function:', error);
    } finally {
        cleanupRunning = false;
    }
}

// Save session data to database before shutdown
async function saveSessionData() {
    try {
        console.log('💾 Saving session data to database...');
        
        for (const [sessionId, session] of activeSessions) {
            await storage.updateSession(sessionId, {
                currentPlayers: session.currentPlayers,
                status: session.status,
                voiceChannelId: session.voiceChannelId,
                updatedAt: new Date()
            });
        }
        
        console.log(`✅ Saved ${activeSessions.size} sessions to database`);
    } catch (error) {
        console.error('❌ Error saving session data:', error);
    }
}

// Load session data from database on startup
async function loadSessionData() {
    try {
        console.log('💾 Loading persistent sessions from database...');
        
        const dbSessions = await storage.getActiveSessions();
        console.log(`📋 Found ${dbSessions.length} active sessions in database`);
        
        let restoredSessions = 0;
        let cleanedSessions = 0;
        
        for (const dbSession of dbSessions) {
            // Check if session is expired
            const sessionAge = Date.now() - new Date(dbSession.createdAt).getTime();
            const maxAge = 20 * 60 * 1000; // 20 minutes
            
            if (sessionAge > maxAge) {
                // Session expired, mark as inactive
                await storage.deleteSession(dbSession.id);
                cleanedSessions++;
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
                currentPlayers: dbSession.currentPlayers || [],
                confirmedPlayers: dbSession.confirmedPlayers || [],
                voiceChannelId: dbSession.voiceChannelId,
                confirmationStartTime: dbSession.confirmationStartTime,
                createdAt: dbSession.createdAt,
                updatedAt: dbSession.updatedAt
            };
            
            activeSessions.set(session.id, session);
            userCreatedSessions.set(session.creatorId, session.id);
            
            // Restore user session tracking
            for (const player of session.currentPlayers) {
                await storage.setUserSession(player.id, session.id);
            }
            
            restoredSessions++;
        }
        
        // Load guild settings
        console.log('📋 Loading guild settings...');
        // Note: Guild settings loading would go here if implemented
        console.log(`📋 Loaded settings for ${guildSettingsCache.size} guilds`);
        
        console.log('✅ Session restoration complete:');
        console.log(`   🔄 Restored: ${restoredSessions} active sessions`);
        console.log(`   🧹 Cleaned: ${cleanedSessions} expired sessions`);
        
    } catch (error) {
        console.error('❌ Error loading session data:', error);
    }
}

// Discord event handlers
client.once('ready', async () => {
    console.log(`🚀 ${client.user.tag} Bot is online! Logged in as ${client.user.tag}`);
    console.log(`🎮 Serving ${client.guilds.cache.size} servers with premium LFG features`);
    
    // Load persistent session data
    await loadSessionData();
    
    // Register slash commands
    const commands = [
        new SlashCommandBuilder()
            .setName('lfg')
            .setDescription('Create a Looking for Group session')
            .addStringOption(option =>
                option.setName('game')
                    .setDescription('Select the game you want to play')
                    .setRequired(true)
                    .addChoices(...games))
            .addStringOption(option =>
                option.setName('gamemode')
                    .setDescription('Select the game mode')
                    .setRequired(true)
                    .setAutocomplete(true))
            .addIntegerOption(option =>
                option.setName('players')
                    .setDescription('Number of players needed (including yourself)')
                    .setRequired(true)
                    .setMinValue(2)
                    .setMaxValue(10))
            .addStringOption(option =>
                option.setName('info')
                    .setDescription('Additional information about your session')
                    .setRequired(false)
                    .setMaxLength(200)),
        
        new SlashCommandBuilder()
            .setName('quickjoin')
            .setDescription('Instantly join an available LFG session')
            .addStringOption(option =>
                option.setName('game')
                    .setDescription('Game you want to join')
                    .setRequired(true)
                    .addChoices(...games))
            .addStringOption(option =>
                option.setName('gamemode')
                    .setDescription('Game mode you want to join')
                    .setRequired(true)
                    .setAutocomplete(true)),
        
        new SlashCommandBuilder()
            .setName('endlfg')
            .setDescription('End your current LFG session'),
        
        new SlashCommandBuilder()
            .setName('help')
            .setDescription('Show bot commands and features')
    ];

    try {
        console.log('Started refreshing application (/) commands.');
        await client.application.commands.set(commands);
        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error('Error registering commands:', error);
    }
    
    console.log('🎯 Bot ready and operational!');
});

// Optimized autocomplete handling with caching
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isAutocomplete()) return;

    if (interaction.commandName === 'lfg' || interaction.commandName === 'quickjoin') {
        const focusedOption = interaction.options.getFocused(true);
        
        if (focusedOption.name === 'gamemode') {
            const selectedGame = interaction.options.getString('game');
            const cacheKey = `${selectedGame}_${focusedOption.value.toLowerCase()}`;
            
            // Check cache first
            if (gameModesCache.has(cacheKey)) {
                await interaction.respond(gameModesCache.get(cacheKey));
                return;
            }
            
            const modes = gameModes[selectedGame] || [];
            const filtered = modes.filter(mode =>
                mode.toLowerCase().includes(focusedOption.value.toLowerCase())
            ).slice(0, 25).map(mode => ({ name: mode, value: mode }));
            
            // Cache result for 30 seconds
            gameModesCache.set(cacheKey, filtered);
            setTimeout(() => gameModesCache.delete(cacheKey), 30000);
            
            await interaction.respond(filtered);
        }
    }
});

// Handle slash command interactions with enhanced error handling
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    try {
        if (interaction.commandName === 'lfg') {
            await handleLFGCommand(interaction);
        } else if (interaction.commandName === 'quickjoin') {
            await handleQuickJoinCommand(interaction);
        } else if (interaction.commandName === 'endlfg') {
            await handleEndLFGCommand(interaction);
        } else if (interaction.commandName === 'help') {
            await handleHelpCommand(interaction);
        }
    } catch (error) {
        console.error(`❌ Error handling command ${interaction.commandName}:`, error);
        
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({
                content: '❌ **Something went wrong!**\n\nPlease try again. If the problem persists, contact support.',
                flags: 64
            }).catch(console.error);
        } else if (interaction.deferred) {
            await interaction.editReply({
                content: '❌ **Something went wrong!**\n\nPlease try again. If the problem persists, contact support.'
            }).catch(console.error);
        }
    }
});

// Handle button interactions with enhanced error handling
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;

    const [action, sessionId] = interaction.customId.split('_');

    try {
        if (action === 'join') {
            await handleJoinSession(interaction, sessionId);
        } else if (action === 'leave') {
            await handleLeaveSession(interaction, sessionId);
        }
    } catch (error) {
        console.error(`❌ Error handling button interaction ${action}:`, error);
        
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({
                content: '❌ **Action failed!**\n\nPlease try again.',
                flags: 64
            }).catch(console.error);
        }
    }
});

// Handle voice state updates for channel monitoring
client.on('voiceStateUpdate', (oldState, newState) => {
    try {
        // Check if someone left a voice channel
        if (oldState.channelId && oldState.channelId !== newState.channelId) {
            const oldChannel = oldState.channel;
            if (oldChannel && oldChannel.members.size === 0) {
                // Channel is now empty, start monitoring
                startEmptyChannelMonitoring(oldChannel.id);
            }
        }

        // Check if someone joined a voice channel
        if (newState.channelId && newState.channelId !== oldState.channelId) {
            const newChannel = newState.channel;
            if (newChannel) {
                // Channel has members, stop monitoring for cleanup
                stopEmptyChannelMonitoring(newChannel.id);
            }
        }
    } catch (error) {
        console.error('❌ Error in voice state update handler:', error);
    }
});

// 🎮 Handle LFG Command
async function handleLFGCommand(interaction) {
    try {
        await interaction.deferReply();

        const game = interaction.options.getString('game');
        const gamemode = interaction.options.getString('gamemode');
        const playersNeeded = interaction.options.getInteger('players');
        const info = interaction.options.getString('info');
        const userId = interaction.user.id;
        const guildId = interaction.guild.id;
        const channelId = interaction.channel.id;

        // Check if user already has an active session
        if (userCreatedSessions.has(userId)) {
            return interaction.editReply({
                content: '❌ **You already have an active LFG session!**\n\n' +
                        '🎮 You can only create one session at a time\n' +
                        '💡 Use `/endlfg` to end your current session first'
            });
        }

        // Check if user is already in any session as a participant
        const participantSession = Array.from(activeSessions.values()).find(session => 
            session.currentPlayers.some(player => player.id === userId)
        );

        if (participantSession) {
            const gameDisplayName = games.find(g => g.value === participantSession.game)?.name || participantSession.game;
            return interaction.editReply({
                content: '❌ **You\'re already in an LFG session!**\n\n' +
                        `🎮 Currently in: **${gameDisplayName}** - ${participantSession.gamemode}\n` +
                        '💡 Leave that session before creating a new one'
            });
        }

        // Validate gamemode for selected game
        if (!gameModes[game] || !gameModes[game].includes(gamemode)) {
            return interaction.editReply({
                content: '❌ **Invalid game mode!**\n\nPlease select a valid game mode for the chosen game.'
            });
        }

        // Check bot permissions before creating session
        if (!hasRequiredPermissions(interaction.guild, interaction.member)) {
            return interaction.editReply({
                content: getPermissionErrorMessage()
            });
        }

        // Create session
        const sessionId = generateSessionId();
        const session = {
            id: sessionId,
            creatorId: userId,
            guildId: guildId,
            channelId: channelId,
            messageId: null,
            game: game,
            gamemode: gamemode,
            playersNeeded: playersNeeded,
            info: info,
            status: 'waiting',
            currentPlayers: [{
                id: userId,
                username: interaction.user.username,
                joinedAt: new Date().toISOString()
            }],
            confirmedPlayers: [],
            voiceChannelId: null,
            confirmationStartTime: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        // Save to database
        await storage.createSession(session);

        // Store in memory
        activeSessions.set(sessionId, session);
        userCreatedSessions.set(userId, sessionId);

        // Track user session
        await storage.setUserSession(userId, sessionId);

        // Create and send embed
        const embed = createLFGEmbed(session);
        const buttons = createLFGButtons(sessionId);

        const message = await interaction.editReply({
            embeds: [embed],
            components: [buttons]
        });

        // Update session with message ID
        session.messageId = message.id;
        await storage.updateSession(sessionId, { messageId: message.id });

        const gameDisplayName = games.find(g => g.value === game)?.name || game;
        console.log(`🎮 New LFG session created: ${gameDisplayName} - ${gamemode} by ${interaction.user.username} (${sessionId.slice(-6)})`);

        // Set timeout for session expiration
        const timeoutId = setTimeout(async () => {
            console.log(`⏰ Session ${sessionId.slice(-6)} expired`);
            await endLFGSession(sessionId, 'expired');
        }, 20 * 60 * 1000); // 20 minutes

        sessionTimeouts.set(sessionId, timeoutId);

    } catch (error) {
        console.error('❌ Error in handleLFGCommand:', error);
        
        if (!interaction.replied) {
            await interaction.editReply({
                content: '❌ **Failed to create LFG session!**\n\nPlease try again. If the problem persists, contact support.'
            }).catch(console.error);
        }
    }
}

// 🚀 Handle Quick Join Command
async function handleQuickJoinCommand(interaction) {
    try {
        const game = interaction.options.getString('game');
        const gamemode = interaction.options.getString('gamemode');
        const userId = interaction.user.id;
        const guildId = interaction.guild.id;
        
        // Check if user is already in a session
        const existingUserSession = userCreatedSessions.get(userId);
        if (existingUserSession) {
            return interaction.reply({
                content: '❌ **You\'re already in an LFG session!**\n\n' +
                        '🎮 You can only be in one session at a time\n' +
                        '💡 Use `/endlfg` to leave your current session first',
                flags: 64
            });
        }
        
        // Check if user is in any session as a participant
        const participantSession = Array.from(activeSessions.values()).find(session => 
            session.currentPlayers.some(player => player.id === userId)
        );
        
        if (participantSession) {
            return interaction.reply({
                content: '❌ **You\'re already in an LFG session!**\n\n' +
                        `🎮 Currently in: **${participantSession.game}** - ${participantSession.gamemode}\n` +
                        '💡 Leave your current session before using Quick Join',
                flags: 64
            });
        }
        
        // Find available sessions for the specified game and gamemode
        const availableSessions = Array.from(activeSessions.values()).filter(session => 
            session.guildId === guildId &&
            session.game === game &&
            session.gamemode === gamemode &&
            session.currentPlayers.length < session.playersNeeded &&
            session.status === 'waiting'
        );
        
        if (availableSessions.length === 0) {
            const gameDisplayName = games.find(g => g.value === game)?.name || game;
            return interaction.reply({
                content: `❌ **No available ${gameDisplayName} sessions found!**\n\n` +
                        `🔍 **Game:** ${gameDisplayName} - ${gamemode}\n` +
                        '💡 Create your own session with `/lfg` or try a different game/mode',
                flags: 64
            });
        }
        
        // Sort by creation time and pick the oldest available session
        availableSessions.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
        const targetSession = availableSessions[0];
        
        // Add user to the session
        targetSession.currentPlayers.push({
            id: userId,
            username: interaction.user.username,
            joinedAt: new Date().toISOString()
        });
        
        // Update database
        await storage.updateSession(targetSession.id, {
            currentPlayers: targetSession.currentPlayers,
            updatedAt: new Date()
        });
        
        // Track user session
        await storage.setUserSession(userId, targetSession.id);
        
        const gameDisplayName = games.find(g => g.value === game)?.name || game;
        
        await interaction.reply({
            content: `✅ **Quick Join successful!**\n\n` +
                    `🎮 **Game:** ${gameDisplayName} - ${gamemode}\n` +
                    `👥 **Players:** ${targetSession.currentPlayers.length}/${targetSession.playersNeeded}\n` +
                    `👤 **Session Creator:** <@${targetSession.creatorId}>\n` +
                    `🆔 **Session ID:** ${targetSession.id.slice(-6)}`,
            flags: 64
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
            await interaction.reply({
                content: '❌ **Quick Join failed!**\n\nSomething went wrong while trying to join a session. Please try again or use `/lfg` to create your own session.',
                flags: 64
            }).catch(console.error);
        }
    }
}

// Initialize bot with proper error handling for Render hosting
async function startBot() {
    try {
        // Ensure database is ready before starting Discord client
        await ensureDatabaseTables();
        
        // Start Discord client with production-grade error handling
        console.log('🔌 Connecting to Discord...');
        await client.login(process.env.DISCORD_TOKEN);
        console.log('🎉 Bot initialization completed successfully!');
        
    } catch (error) {
        console.error('❌ Failed to start bot:', error);
        console.error('🔍 Check your environment variables:');
        console.error('  - DISCORD_TOKEN (bot token)');
        console.error('  - DATABASE_URL (PostgreSQL connection)');
        console.error('🔄 Attempting graceful shutdown...');
        
        // Attempt to close any open connections before exit
        try {
            if (pool) {
                console.log('🗃️ Closing database pool...');
                await pool.end();
            }
            if (server) {
                console.log('🌐 Closing HTTP server...');
                server.close();
            }
        } catch (cleanupError) {
            console.error('Error during cleanup:', cleanupError);
        }
        
        process.exit(1);
    }
}

// 🛑 Handle End LFG Command
async function handleEndLFGCommand(interaction) {
    try {
        await interaction.deferReply({ flags: 64 });

        const userId = interaction.user.id;
        const sessionId = userCreatedSessions.get(userId);

        if (!sessionId) {
            return interaction.editReply({
                content: '❌ **You don\'t have an active LFG session!**\n\n💡 Create a session with `/lfg` first.',
            });
        }

        const session = activeSessions.get(sessionId);
        if (!session) {
            // Clean up orphaned user session
            userCreatedSessions.delete(userId);
            await storage.removeUserSession(userId);
            
            return interaction.editReply({
                content: '❌ **Session not found!**\n\nYour session may have already expired.',
            });
        }

        await endLFGSession(sessionId, 'manual');

        const gameDisplayName = games.find(g => g.value === session.game)?.name || session.game;
        
        await interaction.editReply({
            content: `✅ **Successfully ended your ${gameDisplayName} session!**\n\n🔍 You can now create a new session or join others.`,
        });

        console.log(`🛑 User ${interaction.user.username} manually ended session ${sessionId.slice(-6)}`);

    } catch (error) {
        console.error('❌ Error in handleEndLFGCommand:', error);
        
        if (!interaction.replied) {
            await interaction.editReply({
                content: '❌ **Failed to end session!**\n\nPlease try again.',
            }).catch(console.error);
        }
    }
}

// 📖 Handle Help Command
async function handleHelpCommand(interaction) {
    try {
        const embed = new EmbedBuilder()
            .setTitle('🎮 LFG Bot - Commands & Features')
            .setColor(0x3498db)
            .setDescription('**Looking for Group (LFG) Bot** helps you find teammates and organize gaming sessions!')
            .addFields(
                {
                    name: '🚀 Main Commands',
                    value: '`/lfg` - Create a new LFG session\n' +
                           '`/quickjoin` - Instantly join an available session\n' +
                           '`/endlfg` - End your current LFG session\n' +
                           '`/help` - Show this help message'
                },
                {
                    name: '🎯 How It Works',
                    value: '1️⃣ Create a session with `/lfg`\n' +
                           '2️⃣ Others join with the **Join Session** button\n' +
                           '3️⃣ When full, a private voice channel is created\n' +
                           '4️⃣ Play together and have fun!'
                },
                {
                    name: '🎮 Supported Games',
                    value: '• Valorant • Fortnite • Brawlhalla\n' +
                           '• The Finals • Roblox • Minecraft\n' +
                           '• Marvel Rivals • Rocket League\n' +
                           '• Apex Legends • Call of Duty • Overwatch'
                },
                {
                    name: '✨ Features',
                    value: '• **Private voice channels** for your team\n' +
                           '• **Quick Join** for instant matchmaking\n' +
                           '• **Auto cleanup** after sessions end\n' +
                           '• **Multi-game support** with game modes'
                },
                {
                    name: '⚙️ Tips',
                    value: '• You can only be in **one session** at a time\n' +
                           '• Sessions auto-expire after **20 minutes**\n' +
                           '• Use **Quick Join** for faster matchmaking\n' +
                           '• Voice channels auto-delete when empty'
                }
            )
            .setFooter({ text: 'LFG Bot • Premium Gaming Communities' })
            .setTimestamp();

        await interaction.reply({
            embeds: [embed],
            flags: 64
        });

    } catch (error) {
        console.error('❌ Error in handleHelpCommand:', error);
        
        if (!interaction.replied) {
            await interaction.reply({
                content: '❌ **Failed to show help!**\n\nPlease try again.',
                flags: 64
            }).catch(console.error);
        }
    }
}

// Optimized cleanup schedule (every 2 minutes for better performance)
cron.schedule('*/2 * * * *', () => {
    cleanupExpiredSessions();
});

// Performance monitoring every 10 minutes
cron.schedule('*/10 * * * *', () => {
    const memUsage = process.memoryUsage();
    const avgCleanupTime = cleanupStats.runs > 0 ? Math.round(cleanupStats.totalTime / cleanupStats.runs) : 0;
    
    console.log(`📊 Performance Stats:`);
    console.log(`   Memory: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB used, ${Math.round(memUsage.heapTotal / 1024 / 1024)}MB total`);
    console.log(`   Sessions: ${activeSessions.size} active, ${cleanupStats.sessions} cleaned`);
    console.log(`   Channels: ${cleanupStats.channels} cleaned, ${emptyChannelTimestamps.size} monitored`);
    console.log(`   Cache sizes: Permissions=${permissionCache.size}, GameModes=${gameModesCache.size}, UserSessions=${userSessionCache.size}`);
    console.log(`   Cleanup: ${cleanupStats.runs} runs, ${cleanupStats.errors} errors, ${avgCleanupTime}ms avg`);
    
    // Clear old cache entries if they're getting large
    if (permissionCache.size > 500) {
        const now = Date.now();
        for (const [key, value] of permissionCache.entries()) {
            if (now - value.timestamp > 300000) {
                permissionCache.delete(key);
            }
        }
    }
});

// Enhanced error handling for production
client.on('error', (error) => {
    console.error('Discord client error:', error);
});

client.on('warn', (warning) => {
    console.warn('Discord client warning:', warning);
});

client.on('shardError', (error, shardId) => {
    console.error(`Shard ${shardId} error:`, error);
});

// Register shutdown handlers for hosting environments
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGUSR2', () => gracefulShutdown('SIGUSR2')); // For Render deployments

// Production-grade graceful shutdown handling
async function gracefulShutdown(signal) {
    console.log(`\n🛑 Received ${signal}, starting graceful shutdown...`);
    
    try {
        // Save active sessions to database
        if (activeSessions.size > 0) {
            console.log(`💾 Saving ${activeSessions.size} active sessions...`);
            await saveSessionData();
            console.log('✅ Sessions saved successfully');
        }
        
        // Close Discord client
        if (client.isReady()) {
            console.log('🔌 Closing Discord connection...');
            client.destroy();
        }
        
        // Close database pool
        console.log('🗃️ Closing database connections...');
        await pool.end();
        
        // Close HTTP server
        console.log('🌐 Closing HTTP server...');
        server.close();
        
        console.log('✅ Graceful shutdown completed');
        process.exit(0);
    } catch (error) {
        console.error('❌ Error during shutdown:', error);
        process.exit(1);
    }
}

startBot();
